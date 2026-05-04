import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { hashKey } from "../middleware/auth.js";
import { query, pool } from "../db.js";
import { validateRecipient } from "../services/faucet.js";
import { getCachedNetwork } from "../utils/network.js";

interface ChallengeBody {
  agent_pubkey?: unknown;
}

interface SelfServeBody {
  agent_pubkey?: unknown;
  nonce?: unknown;
  signature?: unknown; // base64
}

// Public self-serve API key issuance for the devnet onboarding flow.
//
// Two-step protocol with proof-of-ownership (codex review on PR #50):
//
//   1. POST /api/v1/keys/self-serve/challenge { agent_pubkey }
//      -> { nonce, message, expiresAt }
//      Server stores the nonce in api_key_challenges with a 60s TTL.
//
//   2. POST /api/v1/keys/self-serve { agent_pubkey, nonce, signature }
//      Server verifies that `signature` is a valid ed25519 signature over
//      the canonical bytes the challenge response told the client to sign,
//      using `agent_pubkey` as the verifying key. If valid, the challenge
//      row is consumed (DELETE) and a fresh API key is issued bound to
//      `agent_pubkey`.
//
// Without the signature step, an attacker could request a key for ANY
// wallet pubkey, then submit records as that wallet (record signatures
// are not yet mandatory) and have the backend trust the binding for
// claim/premium accounting. Codex finding rated High; this is the fix.
//
// Atomicity (codex Medium):
//   - The "max 5 keys per agent_pubkey" cap is enforced inside a
//     transaction with a per-pubkey advisory lock
//     (pg_advisory_xact_lock(hashtext($pubkey))). Concurrent issuances
//     for the same pubkey serialize on the lock, so the SELECT COUNT
//     observed by each transaction is accurate.
//   - Challenge consumption uses DELETE … RETURNING in the same tx so a
//     replayed (pubkey, nonce, signature) tuple cannot mint a second key.
//
// Hardening:
//   - Devnet/localnet only. mainnet, testnet, AND "unknown" return 410.
//   - Per-pubkey rate limit: 1 issuance / hour (fastify-rate-limit).
//   - Per-IP rate limit: 20 issuances / hour (in-memory Map).
//   - Challenge TTL: 60 seconds.
//   - Each issued key is labeled `self-serve-<short-hash>-<timestamp>` for
//     ops grep when investigating abuse.

const CHALLENGE_TTL_MS = 60_000;
const MAX_SELF_SERVE_KEYS_PER_AGENT = 5;
const PER_RECIPIENT_WINDOW = "1 hour";
const IP_HOURLY_LIMIT = 20;

// Canonical message format the agent signs. Pinned here AND echoed back in
// the challenge response so external clients don't have to reconstruct it
// from internal helpers. Bumping the prefix is a breaking-change boundary.
function buildChallengeMessage(nonce: string, agentPubkey: string): string {
  return [
    "Pact Network self-serve API key issuance",
    `Agent: ${agentPubkey}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

// Hash a pubkey into a non-negative bigint suitable for
// pg_advisory_xact_lock. Postgres bigint is signed 64-bit, so we mask the
// top bit. Same pubkey -> same lock id across processes/instances.
function pubkeyLockId(pubkey: string): bigint {
  const hash = createHash("sha256").update(pubkey).digest();
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result = (result << 8n) | BigInt(hash[i]!);
  }
  return result & 0x7fffffffffffffffn;
}

export async function keysRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      hook: "preHandler",
    });

    // ---- step 1: challenge ----------------------------------------------
    scoped.post<{ Body: ChallengeBody }>(
      "/api/v1/keys/self-serve/challenge",
      async (request, reply) => {
        const network = getCachedNetwork();
        if (network !== "devnet" && network !== "localnet") {
          return reply.code(410).send({
            error: "SelfServeDisabled",
            reason:
              network === "mainnet-beta" || network === "testnet"
                ? `Self-serve API keys are devnet/localnet only (this backend is on ${network})`
                : "Self-serve API keys disabled — backend has not detected a devnet/localnet cluster",
            network,
          });
        }

        const body = request.body ?? {};
        let agentPubkey: string;
        try {
          const pk = validateRecipient(
            typeof body.agent_pubkey === "string" ? body.agent_pubkey : "",
          );
          agentPubkey = pk.toBase58();
        } catch (err) {
          return reply.code(400).send({
            error: "InvalidAgentPubkey",
            message: (err as Error).message,
          });
        }

        const nonce = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
        await query(
          `INSERT INTO api_key_challenges (nonce, agent_pubkey, expires_at)
           VALUES ($1, $2, $3)`,
          [nonce, agentPubkey, expiresAt],
        );

        const message = buildChallengeMessage(nonce, agentPubkey);
        return reply.code(201).send({
          nonce,
          message,
          expiresAt: expiresAt.toISOString(),
          ttlSeconds: Math.floor(CHALLENGE_TTL_MS / 1000),
        });
      },
    );

    // ---- step 2: redeem signed challenge for a key ----------------------
    scoped.post<{ Body: SelfServeBody }>(
      "/api/v1/keys/self-serve",
      {
        config: {
          rateLimit: {
            max: 1,
            timeWindow: PER_RECIPIENT_WINDOW,
            keyGenerator: (req: FastifyRequest) => {
              const body = (req.body ?? {}) as SelfServeBody;
              if (typeof body.agent_pubkey === "string" && body.agent_pubkey.length > 0) {
                return `self-serve:${body.agent_pubkey}`;
              }
              return `self-serve-ip:${req.ip}`;
            },
            errorResponseBuilder: (_req, context) => ({
              statusCode: 429,
              error: "Too Many Requests",
              message: `Self-serve key rate limit: wait ${context.after} before requesting another key for this pubkey`,
              retryAfterSec: Math.ceil(context.ttl / 1000),
            }),
          },
        },
      },
      async (request, reply) => {
        const network = getCachedNetwork();
        if (network !== "devnet" && network !== "localnet") {
          return reply.code(410).send({
            error: "SelfServeDisabled",
            reason:
              network === "mainnet-beta" || network === "testnet"
                ? `Self-serve API keys are devnet/localnet only (this backend is on ${network})`
                : "Self-serve API keys disabled — backend has not detected a devnet/localnet cluster",
            network,
          });
        }

        const body = request.body ?? {};
        let agentPubkey: string;
        try {
          const pk = validateRecipient(
            typeof body.agent_pubkey === "string" ? body.agent_pubkey : "",
          );
          agentPubkey = pk.toBase58();
        } catch (err) {
          return reply.code(400).send({
            error: "InvalidAgentPubkey",
            message: (err as Error).message,
          });
        }

        if (typeof body.nonce !== "string" || body.nonce.length === 0) {
          return reply.code(400).send({
            error: "MissingNonce",
            message: "Call POST /api/v1/keys/self-serve/challenge first to obtain a nonce.",
          });
        }
        if (typeof body.signature !== "string" || body.signature.length === 0) {
          return reply.code(400).send({
            error: "MissingSignature",
            message: "Sign the challenge message with the agent_pubkey keypair and submit base64 signature.",
          });
        }

        // Verify ed25519 signature over the canonical challenge message.
        // Anyone who can produce a valid signature here owns (or has been
        // given access to) the keypair backing agent_pubkey.
        let validSig = false;
        try {
          const sigBytes = Buffer.from(body.signature, "base64");
          if (sigBytes.length !== 64) {
            return reply.code(400).send({
              error: "MalformedSignature",
              message: `Expected 64-byte ed25519 signature, got ${sigBytes.length} bytes after base64 decode.`,
            });
          }
          const pubkeyBytes = bs58.decode(agentPubkey);
          const message = Buffer.from(buildChallengeMessage(body.nonce, agentPubkey), "utf8");
          validSig = nacl.sign.detached.verify(
            new Uint8Array(message),
            new Uint8Array(sigBytes),
            new Uint8Array(pubkeyBytes),
          );
        } catch (err) {
          request.log.warn({ err }, "self-serve signature verification threw");
          validSig = false;
        }
        if (!validSig) {
          return reply.code(401).send({
            error: "InvalidSignature",
            message: "Signature does not verify against agent_pubkey for the challenge message.",
          });
        }

        // Atomic challenge consumption + key issuance under a per-pubkey
        // advisory lock. Concurrent requests for the SAME pubkey serialize
        // here so the 5-key cap is observed correctly.
        const lockId = pubkeyLockId(agentPubkey);
        const client = await pool.connect();
        let issued: { apiKey: string; label: string };
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
            lockId.toString(),
          ]);

          // Single-use challenge consumption — if the row is missing,
          // expired, or bound to a different pubkey, reject.
          const consumed = await client.query<{
            agent_pubkey: string;
            expires_at: Date;
          }>(
            `DELETE FROM api_key_challenges
             WHERE nonce = $1
             RETURNING agent_pubkey, expires_at`,
            [body.nonce],
          );
          if (consumed.rowCount === 0) {
            await client.query("ROLLBACK");
            return reply.code(401).send({
              error: "UnknownOrConsumedNonce",
              message: "Nonce is unknown, already used, or expired. Request a fresh challenge.",
            });
          }
          const row = consumed.rows[0]!;
          if (row.agent_pubkey !== agentPubkey) {
            await client.query("ROLLBACK");
            return reply.code(401).send({
              error: "NonceAgentPubkeyMismatch",
              message: "Nonce was issued for a different agent_pubkey.",
            });
          }
          if (row.expires_at.getTime() < Date.now()) {
            await client.query("ROLLBACK");
            return reply.code(401).send({
              error: "ExpiredNonce",
              message: "Challenge expired. Request a fresh one.",
            });
          }

          // Per-pubkey active-key cap, race-free under the advisory lock.
          const countRow = await client.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt
             FROM api_keys
             WHERE agent_pubkey = $1
               AND status = 'active'
               AND label LIKE 'self-serve-%'`,
            [agentPubkey],
          );
          const count = parseInt(countRow.rows[0]?.cnt ?? "0", 10);
          if (count >= MAX_SELF_SERVE_KEYS_PER_AGENT) {
            await client.query("ROLLBACK");
            return reply.code(429).send({
              error: "TooManyKeysForPubkey",
              message: `agent_pubkey already has ${count} active self-serve keys (max ${MAX_SELF_SERVE_KEYS_PER_AGENT}). Reuse an existing key or contact ops to revoke older ones.`,
              agentPubkey,
            });
          }

          const apiKey = `pact_${randomBytes(24).toString("hex")}`;
          const keyHash = hashKey(apiKey);
          const label = `self-serve-${agentPubkey.slice(0, 8)}-${Date.now()}`;
          await client.query(
            "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
            [keyHash, label, agentPubkey],
          );
          await client.query("COMMIT");
          issued = { apiKey, label };
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }

        request.log.info(
          { agentPubkey, label: issued.label, ip: request.ip },
          "self-serve api key issued (signed challenge verified)",
        );

        return reply.code(201).send({
          apiKey: issued.apiKey,
          label: issued.label,
          agentPubkey,
          network,
        });
      },
    );

    // Secondary spam-net: 20 issuances per hour per IP across this scoped
    // router. Same shape as the faucet's IP layer. Covers both /challenge
    // and the issuance call.
    const ipHits = new Map<string, { count: number; resetAt: number }>();
    scoped.addHook("onRequest", async (req, reply) => {
      if (req.method !== "POST") return;
      if (!req.url.startsWith("/api/v1/keys/self-serve")) return;
      const now = Date.now();
      const WINDOW_MS = 60 * 60 * 1000;
      const entry = ipHits.get(req.ip);
      if (!entry || entry.resetAt <= now) {
        ipHits.set(req.ip, { count: 1, resetAt: now + WINDOW_MS });
        return;
      }
      entry.count += 1;
      if (entry.count > IP_HOURLY_LIMIT) {
        reply.header("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: `IP-level self-serve key limit exceeded (${IP_HOURLY_LIMIT}/hour)`,
          retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
        });
      }
    });
  });
}
