/**
 * The golden rule, enforced in one place.
 *
 * `pact.fetch()` behaves like `fetch()`. A covered call is routed through the
 * Pact Market proxy (which classifies, prices, and queues settlement → the
 * settler auto-refunds on breach). ANY Pact-internal problem — unregistered
 * host, paused endpoint, unreachable/failed proxy, missing signing key,
 * unsignable body — silently falls back to a bare fetch of the ORIGINAL url
 * and is reported as `degraded`. It never throws on Pact's behalf.
 *
 * A call is treated as covered ONLY when the proxy demonstrably processed it
 * (X-Pact-Call-Id / X-Pact-Outcome present). An upstream 4xx/5xx that the
 * proxy DID process is a covered, insured outcome and is returned unchanged —
 * that is the whole point. Genuine upstream/network errors on the bare path
 * propagate unchanged.
 */
import { canonicalHostname } from "./hostname.js";
import type { SlugResolver } from "./slug-resolver.js";
import type { SignFn, Vm } from "./signer.js";
import type { MerchantRegistry } from "./merchant-registry.js";
import { verifyProxiedBy } from "./merchant/attestation.js";
import {
  buildProxiedUrl,
  buildAuthHeaders,
  cleanForwardHeaders,
  headersToRecord,
  bodyToBytes,
  parsePactHeaders,
  isPactProcessed,
  type PactResponseHeaders,
} from "./proxy-transport.js";

export type DegradedReason =
  | "unregistered"
  | "paused"
  | "discovery_failed"
  | "invalid_hostname"
  | "unsigned"
  | "unsignable_body"
  | "proxy_unreachable"
  | "proxy_auth_rejected"
  | "proxy_error"
  | "proxy_unprocessed";

/**
 * Attestation outcome on a covered response. Emitted by golden-fetch when
 * X-Pact-Proxied-By + X-Pact-Proxied-Sig are present and verify against the
 * merchant registry (E3). The caller (factory.ts) consumes it to suppress
 * the local observation buffer append and emit the 'attributed' event.
 */
export interface AttributionVerified {
  merchantPubkey: string;
  startedAt: number;
}

export interface GoldenFetchResult {
  response: Response;
  degraded: boolean;
  degradedReason?: DegradedReason;
  pactHeaders: PactResponseHeaders | null;
  callId: string | null;
  host: string | null;
  slug: string | null;
  premiumBps: number | null;
  /**
   * When set, the merchant attested this call via X-Pact-Proxied-By and the
   * SDK should skip its local record write — the merchant is the
   * server-of-record. Null when no attestation was present OR the signature
   * failed to verify (in which case the SDK records as a fallback).
   */
  attribution: AttributionVerified | null;
}

export interface GoldenFetchDeps {
  resolver: SlugResolver;
  /** When set, X-Pact-Proxied-By attestations are verified against this. */
  merchantRegistry?: MerchantRegistry;
  proxyBaseUrl: string;
  project: string;
  network?: string;
  signRequests: boolean;
  agentPubkey: string;
  vm: Vm;
  /** null when the signer cannot expose a raw secret (wallet adapter, or
   *  EVM signer without a private key). Either resolves to ed25519/bs58 or
   *  EIP-191/0x-hex depending on `vm`. */
  sign: SignFn | null;
  fetchImpl: typeof fetch;
  now?: () => number;
}

/**
 * Compute the attestation outcome from a parsed pactHeaders + the agent's
 * outbound timestamp. Verifies against the registry; returns null on any
 * failure mode (no headers, unknown merchant, invalid signature). Caller
 * treats null as "record normally" — the fail-safe-to-record posture lets a
 * malicious upstream that spoofs an unknown pubkey NOT suppress coverage.
 */
function evaluateAttribution(
  deps: GoldenFetchDeps,
  pact: PactResponseHeaders,
  startedAt: number,
  endpoint: string,
  statusCode: number,
  host: string,
): AttributionVerified | null {
  if (!pact.proxiedBy || !pact.proxiedSig) return null;
  if (!deps.merchantRegistry) return null;
  if (!deps.merchantRegistry.hasMerchant(pact.proxiedBy)) return null;
  // PR #223 Section B: a registered merchant may only attest for hostnames
  // it owns. Without this check, any active merchant key in the registry
  // could produce a valid attestation for any host — defeating the spec's
  // spoofing mitigation. Unknown hostnames (or empty registered list)
  // collapse to mismatch → return null and let the SDK record normally.
  const registeredHostnames = deps.merchantRegistry.getMerchantHostnames(pact.proxiedBy);
  if (!registeredHostnames || !registeredHostnames.includes(host)) return null;
  const ok = verifyProxiedBy(
    {
      merchantPubkey: pact.proxiedBy,
      agentPubkey: deps.agentPubkey,
      startedAt,
      endpoint,
      statusCode,
    },
    pact.proxiedSig,
    pact.proxiedBy,
  );
  if (!ok) return null;
  return { merchantPubkey: pact.proxiedBy, startedAt };
}

export async function goldenFetch(
  deps: GoldenFetchDeps,
  url: string,
  init: RequestInit | undefined,
  hostnameOverride?: string,
): Promise<GoldenFetchResult> {
  const method = (init?.method ?? "GET").toUpperCase();

  // Resolve the canonical hostname. A malformed URL is the caller's problem,
  // not Pact's — let the bare fetch surface the native error.
  let host: string;
  try {
    host = canonicalHostname(hostnameOverride ?? url);
  } catch {
    return bare(deps, url, init, "invalid_hostname", null, null);
  }

  const resolution = await deps.resolver.resolve(host);
  if (!resolution.ok) {
    return bare(deps, url, init, resolution.reason, host, null);
  }
  const { slug, premiumBps } = resolution.entry;

  // Covered calls require an identity signature — without it the proxy
  // cannot attribute the call to the agent's pool, so coverage is moot.
  if (!deps.signRequests || deps.sign == null) {
    return bare(deps, url, init, "unsigned", host, slug, premiumBps);
  }

  const bodyBytes = bodyToBytes(init?.body ?? null);
  if (init?.body != null && init.body !== "" && bodyBytes == null) {
    return bare(deps, url, init, "unsignable_body", host, slug, premiumBps);
  }

  const proxiedUrl = buildProxiedUrl(deps.proxyBaseUrl, slug, url);
  // Capture the same `tStart` buildAuthHeaders will use, so the agent's
  // X-Pact-Started-At sent to the proxy matches what we later reconstruct
  // when verifying the proxy's X-Pact-Proxied-Sig attestation.
  const startedAtForVerify = (deps.now ?? Date.now)();
  let authHeaders: Record<string, string>;
  try {
    authHeaders = await buildAuthHeaders({
      method,
      proxiedUrl,
      bodyBytes,
      agentPubkey: deps.agentPubkey,
      sign: deps.sign,
      vm: deps.vm,
      project: deps.project,
      network: deps.network,
      now: () => startedAtForVerify,
    });
  } catch {
    // Signing itself failed (e.g. a malformed/short secret key that slipped
    // past construction-time validation, or a future signer type). Golden
    // rule: never throw on Pact's behalf — degrade to a bare fetch.
    return bare(deps, url, init, "unsigned", host, slug, premiumBps);
  }
  const headers = {
    ...cleanForwardHeaders(headersToRecord(init?.headers)),
    ...authHeaders,
  };

  let resp: Response;
  try {
    resp = await deps.fetchImpl(proxiedUrl, { ...init, method, headers });
  } catch {
    return bare(deps, url, init, "proxy_unreachable", host, slug, premiumBps);
  }

  const pact = parsePactHeaders(resp.headers);
  if (isPactProcessed(pact)) {
    const attribution = evaluateAttribution(
      deps,
      pact,
      startedAtForVerify,
      slug,
      resp.status,
      host,
    );
    return {
      response: resp,
      degraded: false,
      pactHeaders: pact,
      callId: pact.callId,
      host,
      slug,
      premiumBps,
      attribution,
    };
  }

  // Proxy returned but did not process the call as covered: auth rejection,
  // proxy infra error, or an unexpected unannotated response. Fall back.
  const reason: DegradedReason =
    resp.status === 401
      ? "proxy_auth_rejected"
      : resp.status >= 500
        ? "proxy_error"
        : "proxy_unprocessed";
  return bare(deps, url, init, reason, host, slug, premiumBps);
}

async function bare(
  deps: GoldenFetchDeps,
  url: string,
  init: RequestInit | undefined,
  reason: DegradedReason,
  host: string | null,
  slug: string | null,
  premiumBps: number | null = null,
): Promise<GoldenFetchResult> {
  // The bare path IS the caller's call. If it throws, that is a genuine
  // upstream/network error and must propagate unchanged (golden rule).
  //
  // Merchant attribution (Commit 2 C8): even on the bare path, attach
  // x-pact-pubkey + x-pact-started-at so a merchant who runs their own
  // middleware on the upstream host can still attribute and emit an
  // X-Pact-Proxied-By attestation. The startedAt anchor is shared with the
  // proxied path (also Date.now()) so the dedupe key is consistent.
  const startedAt = (deps.now ?? Date.now)();
  const baseHeaders = headersToRecord(init?.headers);
  const headersOut: Record<string, string> = {
    ...baseHeaders,
    "x-pact-pubkey": deps.agentPubkey,
    "x-pact-started-at": String(startedAt),
  };
  const response = await deps.fetchImpl(url, { ...init, headers: headersOut });

  // Direct-mode merchant attribution (Commit 3 L1): even on the bare path,
  // if the upstream's middleware stamped X-Pact-Proxied-By + Sig and the
  // merchant is in our registry, the call IS attributed — we just bypassed
  // the Pact Market proxy. The merchant middleware signs over the request
  // path (req.route.path or req.path), so we reconstruct the same endpoint
  // identifier from the URL to verify the signature.
  let directEndpoint = "";
  try {
    directEndpoint = new URL(url).pathname;
  } catch {
    /* malformed URL — bare path already swallowed it above */
  }
  const pact = parsePactHeaders(response.headers);
  // PR #223 Section B: hostname binding applies on the bare path too.
  // The canonical host comes from the request URL (the agent's intended
  // upstream); the merchant must be registered for that host to attest.
  let bareHost = "";
  try {
    bareHost = canonicalHostname(url);
  } catch {
    /* malformed URL — falls through; evaluateAttribution will mismatch */
  }
  const directAttribution =
    pact.proxiedBy && pact.proxiedSig
      ? evaluateAttribution(deps, pact, startedAt, directEndpoint, response.status, bareHost)
      : null;
  return {
    response,
    degraded: true,
    degradedReason: reason,
    // Surface pactHeaders when proxied-by is present so callers can read
    // the attestation; otherwise null preserves the legacy degraded shape.
    pactHeaders: directAttribution ? pact : null,
    callId: null,
    host,
    slug,
    premiumBps,
    attribution: directAttribution,
  };
}
