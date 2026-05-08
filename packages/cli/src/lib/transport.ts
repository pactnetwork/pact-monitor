import { createHash, randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

const STRIPPED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-helius-api-key",
  "x-birdeye-api-key",
]);

export function buildSignaturePayload(args: {
  method: string;
  path: string;
  timestampMs: number;
  nonce: string;
  bodyHash: string;
}): string {
  return `v1\n${args.method.toUpperCase()}\n${args.path}\n${args.timestampMs}\n${args.nonce}\n${args.bodyHash}`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface SignedRequestResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  callId: string | null;
  attempts: number;
  latencyMs: number;
}

export async function signedRequest(opts: {
  gatewayUrl: string;
  slug: string;
  upstreamPath: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  keypair: Keypair;
  project: string;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<SignedRequestResult> {
  const fullPath = `/v1/${opts.slug}${opts.upstreamPath.startsWith("/") ? "" : "/"}${opts.upstreamPath}`;
  const url = `${opts.gatewayUrl.replace(/\/$/, "")}${fullPath}`;

  const cleanedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) {
    if (!STRIPPED_HEADERS.has(k.toLowerCase())) {
      cleanedHeaders[k] = v;
    }
  }

  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxRetries = opts.maxRetries ?? 2;
  const startedAt = Date.now();
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const ts = Date.now();
    const nonce = bs58.encode(randomBytes(16));
    const bodyStr = opts.body ?? "";
    const bodyHash = bodyStr ? sha256Hex(bodyStr) : "";
    const payload = buildSignaturePayload({
      method: opts.method,
      path: fullPath,
      timestampMs: ts,
      nonce,
      bodyHash,
    });
    const sig = nacl.sign.detached(
      new TextEncoder().encode(payload),
      opts.keypair.secretKey,
    );

    // Bun's compiled-binary fetch advertises `Accept-Encoding: br, gzip, ...`
    // by default and trips a BrotliDecompressionError on some
    // cloudflare-fronted upstreams (birdeye, helius). The Accept-Encoding
    // propagates through the gateway to the upstream, so forcing `gzip` here
    // means brotli is never advertised and the upstream returns gzip — which
    // Bun decompresses fine. Users can still override with --header
    // "Accept-Encoding: identity" (or any other value) to opt out.
    const userSetAcceptEncoding = Object.keys(cleanedHeaders).some(
      (k) => k.toLowerCase() === "accept-encoding",
    );
    const allHeaders: Record<string, string> = {
      ...(userSetAcceptEncoding ? {} : { "accept-encoding": "gzip" }),
      ...cleanedHeaders,
      "x-pact-agent": opts.keypair.publicKey.toBase58(),
      "x-pact-timestamp": String(ts),
      "x-pact-nonce": nonce,
      "x-pact-signature": bs58.encode(sig),
      "x-pact-project": opts.project,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: opts.method,
        headers: allHeaders,
        body: bodyStr || undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const responseBody = await resp.text();
      const respHeaders = Object.fromEntries(resp.headers.entries());

      // Don't retry 4xx
      if (resp.status >= 400 && resp.status < 500) {
        return {
          status: resp.status,
          body: responseBody,
          headers: respHeaders,
          callId: respHeaders["x-pact-call-id"] ?? null,
          attempts: attempt,
          latencyMs: Date.now() - startedAt,
        };
      }
      // Retry 5xx
      if (resp.status >= 500 && attempt <= maxRetries) {
        await sleep(500 * Math.pow(3, attempt - 1));
        continue;
      }
      return {
        status: resp.status,
        body: responseBody,
        headers: respHeaders,
        callId: respHeaders["x-pact-call-id"] ?? null,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err as Error;
      if (attempt <= maxRetries) {
        await sleep(500 * Math.pow(3, attempt - 1));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("transport: unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
