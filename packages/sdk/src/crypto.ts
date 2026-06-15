/**
 * Isomorphic crypto primitives — no `node:crypto`.
 *
 * `globalThis.crypto` (WebCrypto) is present in Node >=18 and every browser,
 * so the signing path runs unchanged in both. SHA-256 over a given
 * `Uint8Array` is byte-identical to Node's `createHash("sha256").update(b)`
 * (same FIPS 180-4 digest of the same bytes) — `proxy-transport.test.ts`
 * pins this with a cross-implementation equality test, because a mismatch is
 * a silent `401 pact_auth_bad_sig` at the proxy.
 *
 * `subtle.digest` is async, so `sha256Hex` is async; this ripples one `await`
 * into `buildAuthHeaders` and `goldenFetch` (both already async).
 */
function webcrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== "function") {
    throw new Error(
      "WebCrypto is unavailable: Pact SDK needs Node >=18 or a browser.",
    );
  }
  return c;
}

/** CSPRNG bytes (replaces node:crypto randomBytes for the request nonce). */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  webcrypto().getRandomValues(b);
  return b;
}

/**
 * Lowercase hex SHA-256 of the EXACT bytes. Must hash the same `Uint8Array`
 * the proxy hashes (raw wire body bytes — see verify-signature.ts), never a
 * re-encoded string.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed array: byte-identical (honors the
  // source view's offset/length) and sidesteps the lib.dom `BufferSource`
  // SharedArrayBuffer variance so the type holds isomorphically.
  const buf = new Uint8Array(bytes);
  const digest = await webcrypto().subtle.digest("SHA-256", buf);
  const v = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < v.length; i++) {
    s += v[i].toString(16).padStart(2, "0");
  }
  return s;
}
