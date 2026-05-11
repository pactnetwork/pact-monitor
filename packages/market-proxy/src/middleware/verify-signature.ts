// Verifies the ed25519 signature the pact-cli attaches to every request
// (see packages/cli/src/lib/transport.ts:36-78). Only enforced when the
// caller presents an `x-pact-agent` header — the dashboard demo path
// using `?pact_wallet=…` is unaffected and remains unauthenticated.
//
// Canonical payload (UTF-8) — MUST match the CLI byte-for-byte:
//
//   v1\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
//
// where:
//   - METHOD     is uppercase ("GET", "POST", ...)
//   - PATH       is pathname + search exactly as sent
//   - TIMESTAMP  is milliseconds since epoch as a decimal string
//   - NONCE      is the bs58-encoded random nonce from the CLI
//   - BODY_HASH  is sha256(body bytes) as a hex string, or "" for empty body

import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const PACT_AUTH_HEADERS = [
  "x-pact-agent",
  "x-pact-timestamp",
  "x-pact-nonce",
  "x-pact-signature",
  "x-pact-project",
] as const;

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
// proxy; multi-instance support is filed as a follow-up.
export function createInMemoryReplayCache(ttlMs: number): ReplayCache {
  const store = new Map<string, number>();
  return {
    seen(key, nowMs) {
      // Opportunistic cleanup: at most one sweep per call, bounded by
      // pruning entries older than `ttlMs`. Avoids unbounded growth
      // without a separate timer.
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
    // Unauthenticated path (e.g. dashboard demo via ?pact_wallet=…) —
    // pass through. The route handler decides whether to insure.
    if (!agent) {
      return next();
    }

    const timestamp = c.req.header("x-pact-timestamp");
    const nonce = c.req.header("x-pact-nonce");
    const signature = c.req.header("x-pact-signature");
    const project = c.req.header("x-pact-project");

    if (!timestamp || !nonce || !signature || !project) {
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

    // Read the body without consuming the original stream — downstream
    // handlers (helius.ts:48, jupiter.ts, ...) still need the body.
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

    // Stash the verified identity for downstream handlers. The proxy
    // route reads it via c.get("verifiedAgent") and prefers it over
    // any header re-read.
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

function reject(
  c: Context,
  code: PactAuthError,
  message: string,
): Response {
  return c.json({ error: code, message }, 401);
}
