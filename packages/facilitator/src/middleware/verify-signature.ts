// Verifies the ed25519 signature the pact-cli attaches to its
// `POST /v1/coverage/register` side-call. This is a near-verbatim copy of
// packages/market-proxy/src/middleware/verify-signature.ts — same canonical
// payload, same replay protection, same skew window — so the CLI uses ONE
// signing routine (packages/cli/src/lib/transport.ts::buildSignaturePayload)
// for both the gateway path and the facilitator side-call.
//
// Difference vs the market-proxy copy: `x-pact-project` is optional here. The
// gateway needs a project for billing attribution; the facilitator does not
// (pay.sh-covered calls are attributed to the agent pubkey + payment tx). The
// canonical payload never included the project header anyway.
//
// Canonical payload (UTF-8) — MUST match the CLI byte-for-byte:
//
//   v1\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
//
// where:
//   - METHOD     is uppercase ("POST")
//   - PATH       is pathname + search exactly as sent (e.g. "/v1/coverage/register")
//   - TIMESTAMP  is milliseconds since epoch as a decimal string
//   - NONCE      is the bs58-encoded random nonce from the CLI
//   - BODY_HASH  is sha256(body bytes) as a hex string, or "" for empty body

import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import bs58 from "bs58";
import nacl from "tweetnacl";

export type PactAuthError =
  | "pact_auth_missing"
  | "pact_auth_stale"
  | "pact_auth_replay"
  | "pact_auth_bad_sig";

export const DEFAULT_SKEW_MS = 30_000;
export const DEFAULT_REPLAY_TTL_MS = 60_000;

export interface ReplayCache {
  seen(key: string, nowMs: number): boolean;
}

// In-memory replay cache. Acceptable for the single-replica Cloud Run
// service; multi-instance support is filed as a follow-up (same caveat as the
// market-proxy's copy).
export function createInMemoryReplayCache(ttlMs: number): ReplayCache {
  const store = new Map<string, number>();
  return {
    seen(key, nowMs) {
      if (store.size > 1024) {
        for (const [k, expires] of store) {
          if (expires <= nowMs) store.delete(k);
        }
      }
      const expires = store.get(key);
      if (expires !== undefined && expires > nowMs) return true;
      store.set(key, nowMs + ttlMs);
      return false;
    },
  };
}

export interface VerifyPactSignatureOptions {
  skewMs?: number;
  replayTtlMs?: number;
  replayCache?: ReplayCache;
  now?: () => number;
}

export function verifyPactSignature(
  opts: VerifyPactSignatureOptions = {},
): MiddlewareHandler {
  const skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
  const replayTtlMs = opts.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const replay = opts.replayCache ?? createInMemoryReplayCache(replayTtlMs);

  return async function pactSignatureMiddleware(c, next) {
    const agent = c.req.header("x-pact-agent");
    // Unlike the gateway, the facilitator register endpoint REQUIRES an
    // authenticated agent — there is no unauthenticated demo path.
    if (!agent) {
      return reject(c, "pact_auth_missing", "missing x-pact-agent header");
    }

    const timestamp = c.req.header("x-pact-timestamp");
    const nonce = c.req.header("x-pact-nonce");
    const signature = c.req.header("x-pact-signature");

    if (!timestamp || !nonce || !signature) {
      return reject(c, "pact_auth_missing", "missing pact auth header");
    }

    const tsMs = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(tsMs)) {
      return reject(c, "pact_auth_stale", "malformed x-pact-timestamp");
    }
    if (Math.abs(now() - tsMs) > skewMs) {
      return reject(c, "pact_auth_stale", "timestamp outside skew window");
    }

    const replayKey = `${agent}:${nonce}`;
    if (replay.seen(replayKey, now())) {
      return reject(c, "pact_auth_replay", "nonce already seen");
    }

    // Read the body without consuming the original stream — the route handler
    // still needs to parse it.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    } catch {
      return reject(c, "pact_auth_bad_sig", "could not read request body");
    }

    const url = new URL(c.req.url);
    const path = url.pathname + url.search;
    const bodyHash = bodyBytes.length === 0 ? "" : sha256Hex(bodyBytes);
    const payload = buildSignaturePayload({
      method: c.req.method,
      path,
      timestampMs: tsMs,
      nonce,
      bodyHash,
    });

    let pubkey: Uint8Array;
    let sig: Uint8Array;
    try {
      pubkey = bs58.decode(agent);
      sig = bs58.decode(signature);
    } catch {
      return reject(c, "pact_auth_bad_sig", "malformed signature or pubkey");
    }
    if (pubkey.length !== 32 || sig.length !== 64) {
      return reject(c, "pact_auth_bad_sig", "wrong signature or pubkey length");
    }

    let verified = false;
    try {
      verified = nacl.sign.detached.verify(
        new TextEncoder().encode(payload),
        sig,
        pubkey,
      );
    } catch {
      verified = false;
    }
    if (!verified) {
      return reject(c, "pact_auth_bad_sig", "signature verification failed");
    }

    // Stash the verified identity for the route handler. The handler must
    // prefer this over re-reading the header AND cross-check it against the
    // `agent` field in the JSON body.
    c.set("verifiedAgent", agent);
    return next();
  };
}

export function buildSignaturePayload(args: {
  method: string;
  path: string;
  timestampMs: number;
  nonce: string;
  bodyHash: string;
}): string {
  return `v1\n${args.method.toUpperCase()}\n${args.path}\n${args.timestampMs}\n${args.nonce}\n${args.bodyHash}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function reject(c: Context, code: PactAuthError, message: string): Response {
  return c.json({ error: code, message }, 401);
}
