import { describe, it, expect } from 'vitest';
import {
  validateFeeRecipients,
  InvalidFeeRecipientsError,
  BpsSumExceedsCapError,
  TreasuryCardinalityError,
  TreasuryBpsZeroError,
} from '../src/fees.js';
import { RecipientKind, type FeeRecipient } from '../src/types.js';
import type { Address } from 'viem';

const T = '0x1111111111111111111111111111111111111111' as Address;
const A = '0x2222222222222222222222222222222222222222' as Address;
const B = '0x3333333333333333333333333333333333333333' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const treasury = (bps: number, dest: Address = T): FeeRecipient => ({
  kind: RecipientKind.Treasury,
  destination: dest,
  bps,
});
const affiliate = (bps: number, dest: Address = A): FeeRecipient => ({
  kind: RecipientKind.Affiliate,
  destination: dest,
  bps,
});

describe('validateFeeRecipients — mirrors PactCore._validateFeeRecipients', () => {
  it('accepts a valid treasury + affiliate set', () => {
    expect(() =>
      validateFeeRecipients([treasury(1_000), affiliate(500)]),
    ).not.toThrow();
  });

  it('rejects an empty array (I1)', () => {
    expect(() => validateFeeRecipients([])).toThrow(InvalidFeeRecipientsError);
  });

  it('rejects > MAX_FEE_RECIPIENTS', () => {
    const rs = [treasury(100)];
    for (let i = 0; i < 8; i++) {
      rs.push(affiliate(10, `0x${(i + 4).toString().padStart(40, '0')}` as Address));
    }
    expect(() => validateFeeRecipients(rs)).toThrow(InvalidFeeRecipientsError);
  });

  it('rejects the zero-address destination', () => {
    expect(() =>
      validateFeeRecipients([treasury(1_000), affiliate(100, ZERO)]),
    ).toThrow(InvalidFeeRecipientsError);
  });

  it('rejects per-entry bps > MAX_SINGLE_RECIPIENT_BPS (10_000), not 3000 (I2)', () => {
    expect(() =>
      validateFeeRecipients([treasury(100), affiliate(10_001)]),
    ).toThrow(InvalidFeeRecipientsError);
    // A single entry at 3001 is fine per-entry (only the SUM cap is 3000):
    expect(() => validateFeeRecipients([treasury(3_001)])).toThrow(
      BpsSumExceedsCapError, // fails the sum cap, NOT the per-entry cap
    );
  });

  it('rejects zero or multiple Treasury recipients', () => {
    expect(() => validateFeeRecipients([affiliate(500)])).toThrow(
      TreasuryCardinalityError,
    );
    expect(() =>
      validateFeeRecipients([treasury(500), treasury(500, A)]),
    ).toThrow(TreasuryCardinalityError);
  });

  it('rejects Treasury bps == 0 (TreasuryBpsZero)', () => {
    expect(() => validateFeeRecipients([treasury(0), affiliate(500)])).toThrow(
      TreasuryBpsZeroError,
    );
  });

  it('rejects duplicate destinations (case-insensitive)', () => {
    expect(() =>
      validateFeeRecipients([treasury(500), affiliate(500, T)]),
    ).toThrow(InvalidFeeRecipientsError);
  });

  it('rejects Σ bps > MAX_TOTAL_FEE_BPS (3000)', () => {
    expect(() =>
      validateFeeRecipients([treasury(2_500), affiliate(1_000, B)]),
    ).toThrow(BpsSumExceedsCapError);
  });
});
