import { SLUG_LEN } from './constants.js';

/**
 * Encode a human slug ("helius-rpc") into the 16-byte fixed-width representation
 * the contract expects. Right-pads with NUL bytes; throws if > SLUG_LEN.
 *
 * Pure utility, identical semantics to v1's `slugBytes` helper in
 * packages/protocol-v1-client/src/pda.ts (chain-agnostic). Reimplemented
 * standalone to avoid a workspace dep on the Solana client.
 */
export function slugBytes(slug: string): Uint8Array {
  const enc = new TextEncoder().encode(slug);
  if (enc.length > SLUG_LEN) {
    throw new Error(`endpoint slug must be <= ${SLUG_LEN} bytes (got ${enc.length})`);
  }
  const out = new Uint8Array(SLUG_LEN);
  out.set(enc);
  return out;
}

/** Accept either a string or raw bytes and normalize to a 16-byte array. */
export function normalizeSlug(slug: Uint8Array | string): Uint8Array {
  if (typeof slug === 'string') return slugBytes(slug);
  if (slug.length === SLUG_LEN) return slug;
  if (slug.length > SLUG_LEN) {
    throw new Error(`endpoint slug must be <= ${SLUG_LEN} bytes (got ${slug.length})`);
  }
  const out = new Uint8Array(SLUG_LEN);
  out.set(slug);
  return out;
}

/** Return 0x-prefixed 32-char hex (Solidity `bytes16`). */
export function slugBytes16(slug: string | Uint8Array): `0x${string}` {
  const bytes = normalizeSlug(slug);
  return ('0x' + Buffer.from(bytes).toString('hex')) as `0x${string}`;
}

/** Inverse of slugBytes: strip trailing NULs and decode as UTF-8. */
export function slugToString(slug: Uint8Array | string): string {
  const bytes = typeof slug === 'string'
    ? Buffer.from(slug.replace(/^0x/, ''), 'hex')
    : slug;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
