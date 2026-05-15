import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import { encodeCallId, decodeCallId, isUuid } from '../src/callId.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const HEX  = '0x550e8400e29b41d4a716446655440000' as Hex;

describe('callId codec', () => {
  it('encodes a canonical UUID to the HIGH-16-bytes bytes16', () => {
    expect(encodeCallId(UUID)).toBe(HEX);
  });

  it('accepts hyphen-free and 0x-prefixed forms', () => {
    expect(encodeCallId('550e8400e29b41d4a716446655440000')).toBe(HEX);
    expect(encodeCallId(HEX)).toBe(HEX);
    expect(encodeCallId(UUID.toUpperCase())).toBe(HEX);
  });

  it('round-trips UUID → bytes16 → UUID', () => {
    expect(decodeCallId(encodeCallId(UUID))).toBe(UUID);
  });

  it('DIFFERS from the naive low-128-bit encoding', () => {
    // Naive (WRONG) Solidity: bytes16(uint128(uint256(bytes32(uuidPaddedRight))))
    // Right-pad the 16-byte UUID to 32 bytes, then keep the LOW 16 bytes →
    // that is the zero padding. Our correct encoding keeps the HIGH 16 bytes.
    const padded32 = encodeAbiParameters(
      [{ type: 'bytes32' }],
      [`0x${'550e8400e29b41d4a716446655440000'.padEnd(64, '0')}` as Hex],
    );
    const naiveLow16 = (`0x${padded32.slice(2).slice(32)}`) as Hex; // low 16 bytes
    expect(naiveLow16).toBe('0x00000000000000000000000000000000');
    expect(encodeCallId(UUID)).not.toBe(naiveLow16);
  });

  it('rejects malformed input', () => {
    expect(() => encodeCallId('not-a-uuid')).toThrow();
    expect(() => encodeCallId('0x1234')).toThrow();
    expect(() => decodeCallId('0xdead' as Hex)).toThrow();
  });

  it('isUuid recognises canonical form only', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});
