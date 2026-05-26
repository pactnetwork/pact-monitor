/**
 * Pact Market proxy transport.
 *
 * The signed-request contract MUST stay byte-for-byte compatible with
 * `packages/market-proxy/src/middleware/verify-signature.ts`. From this SDK
 * release onward we emit the v2 canonical payload, which embeds the network
 * discriminator inside the signed bytes to close the same-VM cross-network
 * replay window:
 *
 *   payload = "v2\n{METHOD}\n{pathname+search}\n{NETWORK}\n{tsMs}\n{nonce}\n{bodyHash}"
 *   bodyHash = sha256(body bytes) hex, or "" for an empty body
 *   NETWORK  = x-pact-network header value, or "" when absent (literal "" in bytes)
 *
 * Signature primitive picked by VM:
 *  - Solana: bs58( nacl.sign.detached(utf8(payload), secretKey) )
 *  - EVM:    0x-hex EIP-191 personal_sign over utf8(payload)
 *
 * Headers shipped:
 *   x-pact-agent | x-pact-timestamp | x-pact-nonce |
 *   x-pact-signature | x-pact-project | x-pact-network (when configured)
 *
 * The proxy enforces ±30s skew and single-use nonces. `x-pact-project` is
 * mandatory (a missing one is a hard 401). There is NO API key.
 *
 * Do NOT substitute `@q3labs/pact-monitor`'s `createSignature()` — it is
 * base64 over a pre-hashed message and the proxy would reject it.
 */
import bs58 from "bs58";
import { randomBytes, sha256Hex } from "./crypto.js";
import type { SignFn, Vm } from "./signer.js";

// Upstream auth the proxy injects itself — never forward the caller's copy
// (matches transport.ts STRIPPED_HEADERS).
const STRIPPED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-helius-api-key",
  "x-birdeye-api-key",
]);

export function buildSignaturePayload(args: {
  method: string;
  path: string;
  network: string;
  timestampMs: number;
  nonce: string;
  bodyHash: string;
}): string {
  return `v2\n${args.method.toUpperCase()}\n${args.path}\n${args.network}\n${args.timestampMs}\n${args.nonce}\n${args.bodyHash}`;
}

/** Normalize a fetch body to the exact bytes that will be sent + hashed. */
export function bodyToBytes(
  body: BodyInit | null | undefined,
): Uint8Array | null {
  if (body === undefined || body === null || body === "") return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  // Streams / FormData / Blob / URLSearchParams: we cannot reproduce the
  // exact wire bytes for the signature here. Signal "unsignable" so the
  // caller degrades to a bare fetch instead of sending a 401-bound request.
  return null;
}

/**
 * Rewrite an upstream URL to its proxied form, preserving path + query:
 *   https://api.helius.xyz/v0/x?y=1  ->  {proxyBase}/v1/<slug>/v0/x?y=1
 */
export function buildProxiedUrl(
  proxyBaseUrl: string,
  slug: string,
  originalUrl: string,
): string {
  const u = new URL(originalUrl);
  const base = proxyBaseUrl.replace(/\/+$/, "");
  return `${base}/v1/${slug}${u.pathname}${u.search}`;
}

export interface AuthHeaderInput {
  method: string;
  proxiedUrl: string;
  bodyBytes: Uint8Array | null;
  agentPubkey: string;
  sign: SignFn;
  vm: Vm;
  project: string;
  network?: string;
  now?: () => number;
}

/** Build the x-pact-* signed header set for a covered request. */
export async function buildAuthHeaders(
  input: AuthHeaderInput,
): Promise<Record<string, string>> {
  const ts = (input.now ?? Date.now)();
  const nonce = bs58.encode(randomBytes(16));
  const u = new URL(input.proxiedUrl);
  const path = u.pathname + u.search;
  const bodyHash =
    input.bodyBytes && input.bodyBytes.length > 0
      ? await sha256Hex(input.bodyBytes)
      : "";
  const payload = buildSignaturePayload({
    method: input.method,
    path,
    network: input.network ?? "",
    timestampMs: ts,
    nonce,
    bodyHash,
  });
  const sigRaw = await input.sign(new TextEncoder().encode(payload));
  const signature =
    input.vm === "evm"
      ? // viem returns a 0x-prefixed hex string already.
        (sigRaw as `0x${string}`)
      : // Solana path returns 64 raw bytes; encode bs58 for the proxy.
        bs58.encode(sigRaw as Uint8Array);
  return {
    "x-pact-agent": input.agentPubkey,
    "x-pact-timestamp": String(ts),
    "x-pact-nonce": nonce,
    "x-pact-signature": signature,
    "x-pact-project": input.project,
    ...(input.network ? { "x-pact-network": input.network } : {}),
  };
}

/** Strip upstream auth + apply the gateway's no-compression workaround. */
export function cleanForwardHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  let userSetAcceptEncoding = false;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (STRIPPED_HEADERS.has(lk)) continue;
    if (lk === "accept-encoding") userSetAcceptEncoding = true;
    out[k] = v;
  }
  if (!userSetAcceptEncoding) {
    // The gateway re-emits the upstream Content-Encoding over an
    // already-decoded body; ask upstreams for plaintext. (transport.ts)
    out["accept-encoding"] = "identity;q=1, *;q=0";
  }
  return out;
}

export interface PactResponseHeaders {
  callId: string | null;
  premiumLamports: bigint | null;
  refundLamports: bigint | null;
  latencyMs: number | null;
  outcome: string | null;
  pool: string | null;
  settlementPending: boolean;
}

function bigOrNull(v: string | null): bigint | null {
  if (v == null) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/** Parse the X-Pact-* annotations the proxy attaches (wrap/src/headers.ts). */
export function parsePactHeaders(headers: Headers): PactResponseHeaders {
  const num = headers.get("X-Pact-Latency-Ms");
  return {
    callId: headers.get("X-Pact-Call-Id"),
    premiumLamports: bigOrNull(headers.get("X-Pact-Premium")),
    refundLamports: bigOrNull(headers.get("X-Pact-Refund")),
    latencyMs: num == null ? null : Number(num),
    outcome: headers.get("X-Pact-Outcome"),
    pool: headers.get("X-Pact-Pool"),
    settlementPending: headers.get("X-Pact-Settlement-Pending") === "1",
  };
}

/** True when the response was demonstrably processed by Pact (covered). */
export function isPactProcessed(p: PactResponseHeaders): boolean {
  return p.callId != null || p.outcome != null;
}

export function headersToRecord(
  h: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
