/**
 * The ONE webhook contract (indexer -> agent), in the repo's existing
 * `v1\n…` ed25519/bs58 family (same as market-proxy verify-signature.ts and
 * @q3labs/pact-sdk proxy-transport.ts). NO HMAC, NO per-agent shared secret:
 * the indexer signs with its own ed25519 key; the agent verifies a single
 * pinned indexer pubkey (it travels in `x-pact-agent`, self-describing).
 *
 *   POST {webhookUrl}
 *   x-pact-event     = "refund.settled"
 *   x-pact-agent     = bs58(indexer signing public key)
 *   x-pact-timestamp = ms epoch decimal string
 *   x-pact-nonce     = bs58(16 random bytes)
 *   x-pact-signature = bs58(ed25519_detached(utf8(CANONICAL), indexerSecret))
 *   CANONICAL = "v1\nPOST\n{path}\n{ts}\n{nonce}\n{sha256hex(rawBodyBytes)}"
 *   body = WebhookPayload (JSON; the EXACT bytes hashed/sent)
 *
 * Replay window is wide (±300s, see SDK receiver): webhook delivery retries
 * with backoff, and `callId` is the real idempotency key anyway.
 */
import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";

export interface WebhookCall {
  callId: string;
  agentPubkey: string;
  /** poller uses `endpointSlug` — keep the same key so mapping is shared. */
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  breach: boolean;
  settledAt: string;
  /** on-chain batch tx signature. */
  signature: string;
}

export interface WebhookPayload {
  type: "settlement.calls";
  version: 1;
  indexerTs: string;
  agentPubkey: string;
  calls: WebhookCall[];
}

export const WEBHOOK_EVENT = "refund.settled";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildWebhookCanonical(args: {
  path: string;
  timestampMs: number;
  nonce: string;
  bodyHash: string;
}): string {
  return `v1\nPOST\n${args.path}\n${args.timestampMs}\n${args.nonce}\n${args.bodyHash}`;
}

/** Load the indexer's ed25519 signer from a bs58 64-byte secret key. */
export function loadSigningKey(secretBs58: string): {
  secretKey: Uint8Array;
  publicKeyBase58: string;
} {
  const secretKey = bs58.decode(secretBs58);
  if (secretKey.length !== 64) {
    throw new Error(
      `INDEXER_WEBHOOK_SIGNING_SECRET must be a bs58 64-byte ed25519 secret ` +
        `key (got ${secretKey.length} bytes)`,
    );
  }
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
  return { secretKey, publicKeyBase58: bs58.encode(kp.publicKey) };
}

/**
 * Sign a webhook request. `webhookUrl` is the agent-registered URL exactly as
 * the indexer will POST it; the signed `path` is its pathname+search.
 */
export function signWebhook(args: {
  secretKey: Uint8Array;
  publicKeyBase58: string;
  webhookUrl: string;
  payload: WebhookPayload;
  now?: () => number;
}): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify(args.payload);
  const bodyBytes = new TextEncoder().encode(body);
  const u = new URL(args.webhookUrl);
  const ts = (args.now ?? Date.now)();
  const nonce = bs58.encode(randomBytes(16));
  const canonical = buildWebhookCanonical({
    path: u.pathname + u.search,
    timestampMs: ts,
    nonce,
    bodyHash: sha256Hex(bodyBytes),
  });
  const sig = nacl.sign.detached(
    new TextEncoder().encode(canonical),
    args.secretKey,
  );
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-pact-event": WEBHOOK_EVENT,
      "x-pact-agent": args.publicKeyBase58,
      "x-pact-timestamp": String(ts),
      "x-pact-nonce": nonce,
      "x-pact-signature": bs58.encode(sig),
    },
  };
}
