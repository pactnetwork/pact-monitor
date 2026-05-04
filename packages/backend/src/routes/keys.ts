import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { hashKey } from "../middleware/auth.js";
import { query, getOne } from "../db.js";
import { validateRecipient } from "../services/faucet.js";
import { getCachedNetwork } from "../utils/network.js";

interface SelfServeBody {
  agent_pubkey?: unknown;
}

// Public self-serve API key issuance for the devnet onboarding flow. Mirrors
// the auth pattern used by /api/v1/faucet/drip: anonymous, devnet-only,
// rate-limited per recipient pubkey and per IP. The whole point is that an
// external developer following docs/agent-quickstart.md can run
// samples/demo/external-agent.ts without ever talking to a human admin.
//
// Why not just publish a shared demo key?
//   - Keys carry an agent_pubkey binding used by maybeCreateClaim and the
//     fraud-detection pending-flag table. A shared key would attribute every
//     external agent's claims to a single fake pubkey and break per-agent
//     telemetry, fraud caps, and on-chain policy lookup.
//
// Why not use admin tokens?
//   - That's what we have today. external-agent.ts dies at "ask your admin"
//     because there's no public admin and the staging ADMIN_TOKEN is not
//     handed out. This is the fix.
//
// Hardening:
//   - Only enabled on devnet/localnet. Mainnet returns 410 Gone.
//   - 1 key per (recipient pubkey) per hour.
//   - 20 keys per IP per hour as a secondary spam net.
//   - DB cap: max 5 self-serve keys per agent_pubkey at any time. Older keys
//     beyond that cap are not auto-revoked here, but the issuance fails so a
//     compromised IP can't keep minting fresh keys for the same wallet to
//     evade per-key rate limits elsewhere.
//   - Each issued key is labeled `self-serve-<short-hash>-<timestamp>` so
//     ops can grep them out of api_keys when investigating abuse.

const MAX_SELF_SERVE_KEYS_PER_AGENT = 5;
const PER_RECIPIENT_WINDOW = "1 hour";
const IP_HOURLY_LIMIT = 20;

export async function keysRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      hook: "preHandler",
    });

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
        // Devnet/localnet only. Fail closed on anything else — including
        // "unknown" (network detection failed at boot) so a misconfigured
        // mainnet deploy with broken cluster detection does not silently
        // start handing out keys to anyone who asks.
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
          // Reuse the faucet's recipient validator: rejects malformed pubkeys
          // and PDAs (off-curve). The wallet that signs transactions for
          // external-agent.ts must be on-curve, so this is the right gate.
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

        // Cap active keys per agent pubkey. Without this, an attacker with
        // rotating IPs could collect many keys for a single wallet and
        // multiply their per-key downstream rate-limit budget.
        const existingCount = await getOne<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt
           FROM api_keys
           WHERE agent_pubkey = $1
             AND status = 'active'
             AND label LIKE 'self-serve-%'`,
          [agentPubkey],
        );
        const count = parseInt(existingCount?.cnt ?? "0", 10);
        if (count >= MAX_SELF_SERVE_KEYS_PER_AGENT) {
          return reply.code(429).send({
            error: "TooManyKeysForPubkey",
            message: `agent_pubkey already has ${count} active self-serve keys (max ${MAX_SELF_SERVE_KEYS_PER_AGENT}). Reuse an existing key or contact ops to revoke older ones.`,
            agentPubkey,
          });
        }

        const apiKey = `pact_${randomBytes(24).toString("hex")}`;
        const keyHash = hashKey(apiKey);
        // Label format: self-serve-<first-8-of-pubkey>-<timestamp>. First-8
        // gives ops a quick visual link back to the wallet without leaking
        // the full pubkey into log labels (full pubkey is in agent_pubkey
        // column anyway). Timestamp dedupes concurrent issuances.
        const label = `self-serve-${agentPubkey.slice(0, 8)}-${Date.now()}`;

        await query(
          "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
          [keyHash, label, agentPubkey],
        );

        request.log.info(
          { agentPubkey, label, ip: request.ip },
          "self-serve api key issued",
        );

        return reply.code(201).send({
          apiKey,
          label,
          agentPubkey,
          network,
        });
      },
    );

    // Secondary spam-net: 20 issuances per hour per IP across this scoped
    // router. Same shape as the faucet's IP layer.
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
