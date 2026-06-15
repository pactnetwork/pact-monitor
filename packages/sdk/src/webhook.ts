/**
 * Optional webhook receiver — the latency-optimization counterpart to the
 * durable poller. The indexer POSTs settled calls here signed with the ONE
 * contract (see indexer refund-delivery/webhook-payload.ts):
 *
 *   x-pact-event=refund.settled  x-pact-agent=bs58(indexer pubkey)
 *   x-pact-timestamp  x-pact-nonce  x-pact-signature=bs58(ed25519)
 *   CANONICAL = v1\nPOST\n{path}\n{ts}\n{nonce}\n{sha256hex(rawBody)}
 *
 * The agent pins ONE indexer pubkey (`config.webhook.indexerSigningKey`):
 * no key distribution, no shared secret. Verification: pinned-key match,
 * ±skew (default 300s — delivery retries with backoff; callId is the real
 * idempotency key), single-use nonce, ed25519 over the canonical string.
 *
 * Golden rule: a bad / forged / stale / replayed payload is dropped (4xx,
 * `onReject`), NEVER throws into the host app. Every accepted call is routed
 * through the SAME `reconcile` sink the poller uses, so webhook+poll cannot
 * double-emit (see factory `recordSettled`).
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { sha256Hex } from "./crypto.js";

export interface SettlementNotification {
  callId: string;
  slug: string;
  premiumLamports: bigint;
  refundLamports: bigint;
  breach: boolean;
  settledAt: Date;
  txSignature: string;
}

export interface WebhookConfig {
  /** Pinned bs58 ed25519 PUBLIC key of the indexer (required). */
  indexerSigningKey: string;
  /** Replay/skew window (ms). Default 300_000. */
  skewMs?: number;
  /** Start a standalone Node http listener on this port (optional). */
  port?: number;
  host?: string;
  /** Observe drops (forged/stale/replay). Never throws. */
  onReject?: (reason: string) => void;
}

interface WebhookCallWire {
  callId: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  breach: boolean;
  settledAt: string;
  signature: string;
}
interface WebhookPayloadWire {
  type: string;
  version: number;
  agentPubkey: string;
  calls: WebhookCallWire[];
}

export interface WebhookHandlerRequest {
  method: string;
  /** pathname + search exactly as delivered (what the indexer signed). */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Raw bytes if available; a string is encoded as UTF-8. */
  body: Uint8Array | string;
}
export interface WebhookHandlerResponse {
  status: number;
  body?: string;
}

function toBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

function header(
  h: WebhookHandlerRequest["headers"],
  k: string,
): string | undefined {
  const v = h[k] ?? h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

class ReplayGuard {
  private readonly seen = new Map<string, number>();
  check(key: string, ttlMs: number): boolean {
    const now = Date.now();
    if (this.seen.size > 2048) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    }
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > now) return true;
    this.seen.set(key, now + ttlMs);
    return false;
  }
}

export interface WebhookDeps {
  config: WebhookConfig;
  /** Single shared sink (factory `recordSettled`) — idempotent. */
  reconcile: (n: SettlementNotification) => void;
}

/**
 * Framework-agnostic handler. Wire it to Express/Fastify/Next/Lambda. Always
 * resolves a {status} — never throws.
 */
export function createWebhookHandler(
  deps: WebhookDeps,
): (req: WebhookHandlerRequest) => Promise<WebhookHandlerResponse> {
  const skewMs = deps.config.skewMs ?? 300_000;
  const replay = new ReplayGuard();
  let pinnedKey: Uint8Array | null = null;
  try {
    pinnedKey = bs58.decode(deps.config.indexerSigningKey);
  } catch {
    pinnedKey = null;
  }

  return async (req): Promise<WebhookHandlerResponse> => {
    const reject = (code: number, reason: string): WebhookHandlerResponse => {
      deps.config.onReject?.(reason);
      return { status: code, body: JSON.stringify({ error: reason }) };
    };
    try {
      if (!pinnedKey || pinnedKey.length !== 32) {
        return reject(500, "indexerSigningKey not configured");
      }
      const agent = header(req.headers, "x-pact-agent");
      const ts = header(req.headers, "x-pact-timestamp");
      const nonce = header(req.headers, "x-pact-nonce");
      const signature = header(req.headers, "x-pact-signature");
      if (!agent || !ts || !nonce || !signature) {
        return reject(400, "missing pact webhook headers");
      }
      // Pinned-key match: the signer MUST be the configured indexer key.
      let agentKey: Uint8Array;
      try {
        agentKey = bs58.decode(agent);
      } catch {
        return reject(401, "bad x-pact-agent");
      }
      if (
        agentKey.length !== 32 ||
        !agentKey.every((b, i) => b === pinnedKey![i])
      ) {
        return reject(401, "signer is not the pinned indexer key");
      }
      const tsMs = Number.parseInt(ts, 10);
      if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > skewMs) {
        return reject(401, "timestamp outside skew window");
      }
      if (replay.check(`${agent}:${nonce}`, skewMs)) {
        return reject(401, "nonce replay");
      }

      const bodyBytes =
        typeof req.body === "string"
          ? new TextEncoder().encode(req.body)
          : req.body;
      const bodyHash =
        bodyBytes.length === 0 ? "" : await sha256Hex(bodyBytes);
      const canonical = `v1\nPOST\n${req.path}\n${tsMs}\n${nonce}\n${bodyHash}`;
      let sig: Uint8Array;
      try {
        sig = bs58.decode(signature);
      } catch {
        return reject(401, "bad signature encoding");
      }
      const ok =
        sig.length === 64 &&
        nacl.sign.detached.verify(
          new TextEncoder().encode(canonical),
          sig,
          pinnedKey,
        );
      if (!ok) return reject(401, "signature verification failed");

      let payload: WebhookPayloadWire;
      try {
        payload = JSON.parse(
          new TextDecoder().decode(bodyBytes),
        ) as WebhookPayloadWire;
      } catch {
        return reject(400, "malformed JSON body");
      }
      if (!payload || !Array.isArray(payload.calls)) {
        return reject(400, "missing calls[]");
      }
      // Verified + authentic: route every call through the SHARED idempotent
      // sink (same as the poller). Duplicates are no-ops there.
      for (const c of payload.calls) {
        deps.reconcile({
          callId: c.callId,
          slug: c.endpointSlug,
          premiumLamports: toBig(c.premiumLamports),
          refundLamports: toBig(c.refundLamports),
          breach: c.breach,
          settledAt: new Date(c.settledAt),
          txSignature: c.signature,
        });
      }
      return { status: 202, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      // Absolute backstop — the receiver must never crash the host app.
      return reject(400, `unhandled: ${(err as Error).message}`);
    }
  };
}

/**
 * Optional Node standalone listener. Behind a dynamic `node:http` import so a
 * browser bundle never resolves it.
 */
export async function startWebhookServer(
  deps: WebhookDeps,
): Promise<{ close: () => Promise<void> }> {
  const handler = createWebhookHandler(deps);
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void handler({
        method: req.method ?? "POST",
        path: req.url ?? "/",
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: new Uint8Array(Buffer.concat(chunks)),
      }).then((r) => {
        res.statusCode = r.status;
        res.setHeader("content-type", "application/json");
        res.end(r.body ?? "");
      });
    });
    req.on("error", () => {
      res.statusCode = 400;
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(deps.config.port, deps.config.host, resolve),
  );
  if (typeof server.unref === "function") server.unref();
  return {
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
