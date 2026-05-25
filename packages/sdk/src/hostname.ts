/**
 * Canonical hostname derivation — self-contained copy of
 * `packages/backend/src/utils/hostname.ts`. The SDK must NOT depend on the
 * backend package (a NestJS server, not a library), and the rules MUST stay
 * byte-identical to the backend/proxy so a hostname maps to the same endpoint
 * slug on both sides. Any drift here re-fragments pool attribution.
 *
 * Strips scheme/path/query/userinfo, normalizes port and IDN punycode (via
 * WHATWG URL), lowercases, and strips trailing FQDN dots.
 */
export function canonicalHostname(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("canonicalHostname: input must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("canonicalHostname: input must not be empty");
  }

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`canonicalHostname: invalid hostname '${input}'`);
  }

  // WHATWG URL preserves trailing dots on FQDNs (`foo.com.` !== `foo.com`).
  // Strip them so the canonical form round-trips in either direction.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.length === 0) {
    throw new Error(`canonicalHostname: invalid hostname '${input}'`);
  }
  return host;
}
