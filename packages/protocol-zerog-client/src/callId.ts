import type { Hex } from 'viem';

/**
 * UUID ⇄ `bytes16` callId codec.
 *
 * The on-chain `SettlementRecord.callId` is a `bytes16`. The settler generates
 * a UUID in `@pact-network/wrap`; the canonical encoding is the HIGH 16 bytes:
 *
 *   drop hyphens → 32 hex chars → `0x<32 hex>`  (a bytes16 literal)
 *
 * In Solidity this equals `bytes16(bytes32(uuidHexPaddedRight))` — it keeps
 * the FIRST 16 bytes. The naive `bytes16(uint128(uint256(...)))` keeps the
 * LOW 128 bits (the wrong half — all zero padding for a 16-byte UUID). See
 * the round-trip test for the explicit mismatch assertion.
 */

const HEX32 = /^[0-9a-f]{32}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encode a UUID string OR an arbitrary 16-byte hex into a `bytes16` hex.
 * Accepts: canonical UUID (`550e8400-e29b-41d4-a716-446655440000`),
 * hyphen-free 32-hex, or `0x`-prefixed 32-hex.
 */
export function encodeCallId(input: string): Hex {
  let hex = input.trim().toLowerCase();
  if (hex.startsWith('0x')) hex = hex.slice(2);
  hex = hex.replace(/-/g, '');

  if (!HEX32.test(hex)) {
    throw new Error(
      `encodeCallId: expected a UUID or 16-byte hex, got "${input}"`,
    );
  }
  return `0x${hex}` as Hex;
}

/**
 * Decode a `bytes16` callId back to a canonical UUID string
 * (`8-4-4-4-12`). Inverse of `encodeCallId` for UUID inputs.
 */
export function decodeCallId(callId: Hex): string {
  const hex = callId.slice(2).toLowerCase();
  if (!HEX32.test(hex)) {
    throw new Error(`decodeCallId: expected 16-byte hex, got "${callId}"`);
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** True if `s` is a canonical UUID string. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}
