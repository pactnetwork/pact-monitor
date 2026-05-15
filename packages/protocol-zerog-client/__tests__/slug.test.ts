import { describe, it, expect } from 'vitest';
import {
  slugBytes,
  normalizeSlug,
  slugBytes16,
  slugToString,
} from '../src/slug.js';

describe('slug codec', () => {
  it('right-pads to 16 bytes with NUL', () => {
    const b = slugBytes('helius');
    expect(b.length).toBe(16);
    expect(Array.from(b.slice(0, 6))).toEqual(
      Array.from(new TextEncoder().encode('helius')),
    );
    expect(Array.from(b.slice(6))).toEqual(new Array(10).fill(0));
  });

  it('throws when slug exceeds 16 bytes', () => {
    expect(() => slugBytes('x'.repeat(17))).toThrow();
  });

  it('slugBytes16 produces a 0x + 32-hex literal', () => {
    expect(slugBytes16('helius')).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('round-trips through slugToString (trailing NUL stripped)', () => {
    expect(slugToString(slugBytes('birdeye'))).toBe('birdeye');
    expect(slugToString(slugBytes16('jupiter'))).toBe('jupiter');
  });

  it('normalizeSlug accepts raw 16-byte input unchanged', () => {
    const raw = new Uint8Array(16).fill(7);
    expect(normalizeSlug(raw)).toBe(raw);
  });

  it('handles a slug that uses the full 16 bytes', () => {
    const full = 'abcdefghijklmnop'; // exactly 16
    expect(slugToString(slugBytes(full))).toBe(full);
  });
});
