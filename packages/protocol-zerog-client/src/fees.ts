import { MAX_FEE_RECIPIENTS, MAX_TOTAL_FEE_BPS } from './constants.js';
import { type FeeRecipient, RecipientKind } from './types.js';

export class InvalidFeeRecipientsError extends Error {
  constructor(msg: string) { super(`InvalidFeeRecipients: ${msg}`); this.name = 'InvalidFeeRecipientsError'; }
}
export class BpsSumExceedsCapError extends Error {
  constructor(sum: number) { super(`BpsSumExceedsCap: sum=${sum} cap=${MAX_TOTAL_FEE_BPS}`); this.name = 'BpsSumExceedsCapError'; }
}
export class TreasuryCardinalityError extends Error {
  constructor(count: number) { super(`TreasuryCardinalityViolation: ${count} treasury recipients (must be exactly 1)`); this.name = 'TreasuryCardinalityError'; }
}

/**
 * Client-side mirror of `PactCore._validateFeeRecipients`. Run this BEFORE
 * submitting an admin tx so the user gets a clear error instead of a generic
 * revert.
 */
export function validateFeeRecipients(recipients: FeeRecipient[]): void {
  if (recipients.length > MAX_FEE_RECIPIENTS) {
    throw new InvalidFeeRecipientsError(`max ${MAX_FEE_RECIPIENTS} recipients, got ${recipients.length}`);
  }

  const treasuryCount = recipients.filter(r => r.kind === RecipientKind.Treasury).length;
  if (treasuryCount !== 1) throw new TreasuryCardinalityError(treasuryCount);

  const seen = new Set<string>();
  for (const r of recipients) {
    const k = r.destination.toLowerCase();
    if (seen.has(k)) throw new InvalidFeeRecipientsError(`duplicate destination ${r.destination}`);
    seen.add(k);
  }

  let sum = 0;
  for (const r of recipients) {
    if (r.bps < 0 || r.bps > MAX_TOTAL_FEE_BPS) {
      throw new InvalidFeeRecipientsError(`bps out of range: ${r.bps}`);
    }
    sum += r.bps;
  }
  if (sum > MAX_TOTAL_FEE_BPS) throw new BpsSumExceedsCapError(sum);
}
