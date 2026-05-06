// Per-endpoint upstream-header sanitisation.
//
// Alan review M1: previously every endpoint built upstream Headers via
// `new Headers(req.headers); headers.delete("host")` — i.e. the proxy
// forwarded EVERY caller-supplied header to the upstream provider. That
// leaks caller `Authorization`, `Cookie`, and other identity material to
// third-party APIs that the agent never intended to share.
//
// The sanitiser below replaces that with a strict allowlist:
//
//   - Always forward: Content-Type, Accept, Accept-Encoding, User-Agent
//   - Per-endpoint allowance for upstream auth headers (passed via the
//     `extraAllowed` set):
//       * Birdeye: X-API-KEY (intentional passthrough)
//       * Helius:  none (auth via query string `?api-key=`)
//       * Jupiter: none (no auth)
//       * Elfa:    none — Bearer token would belong here if introduced;
//                  for now the upstream relies on per-deploy proxy auth.
//                  TODO: confirm with upstream API spec.
//       * fal:     none — fal.ai uses `Authorization: Key <key>` injected
//                  server-side; we never forward caller auth.
//                  TODO: confirm with upstream API spec.
//
//   - Always rejected (caller cannot smuggle these to upstream even if
//     they're in extraAllowed): Authorization, Cookie, Set-Cookie,
//     Proxy-Authorization, X-Forwarded-* — these are caller identity
//     markers or proxy chain metadata that must never leak to a third
//     party.
//
// We deliberately keep the allowlist small and explicit. Adding a header
// is a security-relevant change and should be reviewed.

const BASE_ALLOWED = new Set([
  "content-type",
  "accept",
  "accept-encoding",
  "user-agent",
]);

// Headers we refuse to forward upstream regardless of the per-endpoint
// allowlist. These are identity / chain-metadata headers that are scoped
// to the proxy boundary and must never reach third-party APIs.
const ALWAYS_DENIED = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "host",
]);

/**
 * Return a NEW Headers instance containing ONLY the headers permitted to
 * be forwarded upstream by this endpoint.
 *
 * @param incoming  The caller's inbound Headers.
 * @param extraAllowed  Lower-case header names this endpoint permits in
 *                      addition to the base set (e.g. `x-api-key` for
 *                      Birdeye). Headers in ALWAYS_DENIED are rejected
 *                      even if listed here.
 */
export function buildUpstreamHeaders(
  incoming: Headers,
  extraAllowed: ReadonlySet<string> = new Set(),
): Headers {
  const out = new Headers();
  for (const [rawName, value] of incoming.entries()) {
    const name = rawName.toLowerCase();
    if (ALWAYS_DENIED.has(name)) continue;
    if (BASE_ALLOWED.has(name) || extraAllowed.has(name)) {
      out.set(rawName, value);
    }
  }
  return out;
}
