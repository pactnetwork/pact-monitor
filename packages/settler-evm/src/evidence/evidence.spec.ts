import { describe, it, expect } from 'vitest';
import {
  buildEvidenceBlob,
  canonicalEvidenceJson,
  type EvidenceInput,
} from './evidence';

const base: EvidenceInput = {
  callId: '550e8400-e29b-41d4-a716-446655440000',
  agent: '0x1111111111111111111111111111111111111111',
  endpointSlug: 'llama-3-8b',
  premiumWei: 1_000n,
  refundWei: 0n,
  latencyMs: 412,
  outcome: 'ok',
  breach: false,
  ts: '2026-05-15T12:00:00.000Z',
};

describe('canonical evidence blob', () => {
  it('emits keys in the fixed order with BigInt as decimal strings', () => {
    expect(canonicalEvidenceJson(base)).toBe(
      '{"callId":"550e8400-e29b-41d4-a716-446655440000",' +
        '"agent":"0x1111111111111111111111111111111111111111",' +
        '"endpointSlug":"llama-3-8b","premiumWei":"1000","refundWei":"0",' +
        '"latencyMs":412,"outcome":"ok","breach":false,' +
        '"ts":"2026-05-15T12:00:00.000Z"}',
    );
  });

  it('is byte-stable across repeated calls (content-addressed idempotency)', () => {
    const a = buildEvidenceBlob(base);
    const b = buildEvidenceBlob({ ...base });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('ignores input key order — output depends only on values', () => {
    const reordered: EvidenceInput = {
      ts: base.ts,
      breach: base.breach,
      outcome: base.outcome,
      latencyMs: base.latencyMs,
      refundWei: base.refundWei,
      premiumWei: base.premiumWei,
      endpointSlug: base.endpointSlug,
      agent: base.agent,
      callId: base.callId,
    };
    expect(canonicalEvidenceJson(reordered)).toBe(canonicalEvidenceJson(base));
  });

  it('serializes large uint96 premiums without precision loss', () => {
    const big = (2n ** 96n) - 1n;
    const json = canonicalEvidenceJson({ ...base, premiumWei: big });
    expect(json).toContain(`"premiumWei":"${big.toString()}"`);
  });

  it('distinguishes breach vs non-breach (different bytes)', () => {
    const ok = buildEvidenceBlob(base);
    const breached = buildEvidenceBlob({ ...base, breach: true, refundWei: 5_000n });
    expect(Array.from(ok)).not.toEqual(Array.from(breached));
  });
});
