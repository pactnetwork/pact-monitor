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

export interface GoldenFetchResult {
  response: Response;
  degraded: boolean;
  degradedReason?: DegradedReason;
  pactHeaders: PactResponseHeaders | null;
  callId: string | null;
  host: string | null;
  slug: string | null;
  premiumBps: number | null;
}

export interface GoldenFetchDeps {
  resolver: SlugResolver;
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
      now: deps.now,
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
    return {
      response: resp,
      degraded: false,
      pactHeaders: pact,
      callId: pact.callId,
      host,
      slug,
      premiumBps,
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
  const response = await deps.fetchImpl(url, init);
  return {
    response,
    degraded: true,
    degradedReason: reason,
    pactHeaders: null,
    callId: null,
    host,
    slug,
    premiumBps,
  };
}
