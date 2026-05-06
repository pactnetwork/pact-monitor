// Alan review M2: strip upstream-leak headers from proxy responses.
//
// When the proxy returns a Response built from the upstream provider, the
// upstream's Set-Cookie / Server / X-Powered-By / Access-Control-* headers
// must not leak through to the caller. Rationale:
//
//   - Set-Cookie: would let upstream set cookies on the proxy's origin,
//     which is a session-pinning risk.
//   - Server / X-Powered-By / Via / X-AspNet-Version: fingerprints the
//     upstream stack, useful only to attackers.
//   - Access-Control-*: must be authored by the proxy (to match the proxy's
//     CORS policy), not parroted from upstream — a permissive upstream
//     would otherwise effectively expand the proxy's CORS surface.
//
// We replace upstream CORS headers with a permissive proxy policy
// (Allow-Origin: *, no credentials) for now. Tighten when we have a real
// allowed-origins list.

const STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "set-cookie",
  "server",
  "via",
  "x-powered-by",
  "x-aspnet-version",
  "x-aspnetmvc-version",
  // Access-Control-* — explicit list (Headers API doesn't support prefix
  // delete). We rewrite Allow-Origin afterwards.
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

export interface SanitiseResponseHeadersOptions {
  /** If true, set proxy CORS policy on the result. Default: true. */
  applyCors?: boolean;
}

/**
 * Return a NEW Headers instance with upstream-leak headers stripped and
 * the proxy's own CORS policy applied. Caller-extra headers (e.g. wrap's
 * X-Pact-*) should be added on top of the result by the caller.
 */
export function sanitiseUpstreamResponseHeaders(
  upstream: Headers,
  opts: SanitiseResponseHeadersOptions = {},
): Headers {
  const out = new Headers();
  for (const [name, value] of upstream.entries()) {
    if (STRIPPED_HEADERS.has(name.toLowerCase())) continue;
    out.set(name, value);
  }
  if (opts.applyCors !== false) {
    // Permissive proxy CORS — tighten when an allowed-origins list is
    // available. We never echo Allow-Credentials with Allow-Origin: *.
    out.set("Access-Control-Allow-Origin", "*");
  }
  return out;
}

/**
 * Build a NEW Response with sanitised headers, copying body / status from
 * the source. `extraHeaders` (e.g. X-Pact-*) are added on top.
 */
export function buildSanitisedResponse(
  source: Response,
  extraHeaders: Headers | Record<string, string> = {},
  opts: SanitiseResponseHeadersOptions = {},
): Response {
  const headers = sanitiseUpstreamResponseHeaders(source.headers, opts);
  const extras = extraHeaders instanceof Headers
    ? extraHeaders
    : new Headers(extraHeaders);
  for (const [name, value] of extras.entries()) {
    headers.set(name, value);
  }
  return new Response(source.body, {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}
