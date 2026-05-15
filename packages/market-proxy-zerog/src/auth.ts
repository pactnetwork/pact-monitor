// EVM ECDSA agent auth for market-proxy-zerog.
//
// FRESH implementation — NOT a port of the Solana nacl/ed25519 middleware
// (different scheme). Only the chain-agnostic pieces are reused: the
// canonical payload string, the replay cache, and the skew window.
//
// Canonical payload (UTF-8) — MUST match the signer byte-for-byte:
//
//   v1\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
//
//   METHOD     uppercase ("GET", "POST", ...)
//   PATH       pathname + search exactly as sent
//   TIMESTAMP  ms since epoch, decimal string
//   NONCE      caller-supplied string
//   BODY_HASH  sha256(body bytes) hex, or "" for an empty body
//
// The agent signs with EIP-191 `personal_sign` over that exact UTF-8 string.
// viem `recoverMessageAddress({ message })` applies the
// `\x19Ethereum Signed Message:\n<len>` prefix, so a plain-string `message`
// (NEVER `{ raw }`) recovers the personal_sign signer.

import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getAddress, isAddress, recoverMessageAddress, type Hex } from 'viem';

export type PactAuthError =
  | 'pact_auth_missing'
  | 'pact_auth_stale'
  | 'pact_auth_replay'
  | 'pact_auth_bad_sig';

export const DEFAULT_SKEW_MS = 30_000;
export const DEFAULT_REPLAY_TTL_MS = 60_000;

export interface ReplayCache {
  seen(key: string, nowMs: number): boolean;
}

// In-memory replay cache. Acceptable for the single-replica Cloud Run proxy
// (ported verbatim from the Solana proxy — chain-agnostic).
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
  return createHash('sha256').update(bytes).digest('hex');
}

function reject(c: Context, code: PactAuthError, message: string): Response {
  return c.json({ error: code, message }, 401);
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
    const agent = c.req.header('x-pact-agent');
    // Unauthenticated path (dashboard demo via ?pact_wallet=) — pass through;
    // the route decides whether to insure.
    if (!agent) {
      return next();
    }

    const timestamp = c.req.header('x-pact-timestamp');
    const nonce = c.req.header('x-pact-nonce');
    const signature = c.req.header('x-pact-signature');
    const project = c.req.header('x-pact-project');

    if (!timestamp || !nonce || !signature || !project) {
      return reject(c, 'pact_auth_missing', 'missing pact auth header');
    }
    if (!isAddress(agent)) {
      return reject(c, 'pact_auth_bad_sig', 'x-pact-agent is not an EVM address');
    }

    const tsMs = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(tsMs)) {
      return reject(c, 'pact_auth_stale', 'malformed x-pact-timestamp');
    }
    if (Math.abs(now() - tsMs) > skewMs) {
      return reject(c, 'pact_auth_stale', 'timestamp outside skew window');
    }

    const replayKey = `${agent}:${nonce}`;
    if (replay.seen(replayKey, now())) {
      return reject(c, 'pact_auth_replay', 'nonce already seen');
    }

    // Clone so route handlers can still read the body downstream. This MUST
    // be the first body touch in the chain (clone-before-consume).
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    } catch {
      return reject(c, 'pact_auth_bad_sig', 'could not read request body');
    }

    const url = new URL(c.req.url);
    const path = url.pathname + url.search;
    const bodyHash = bodyBytes.length === 0 ? '' : sha256Hex(bodyBytes);
    const payload = buildSignaturePayload({
      method: c.req.method,
      path,
      timestampMs: tsMs,
      nonce,
      bodyHash,
    });

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: payload,
        signature: signature as Hex,
      });
    } catch {
      return reject(c, 'pact_auth_bad_sig', 'signature recovery failed');
    }
    if (getAddress(recovered) !== getAddress(agent)) {
      return reject(c, 'pact_auth_bad_sig', 'signature does not match x-pact-agent');
    }

    // Stash the checksummed identity for the route.
    c.set('verifiedAgent', getAddress(agent));
    return next();
  };
}
