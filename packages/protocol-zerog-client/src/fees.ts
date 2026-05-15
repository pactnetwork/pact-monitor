import {
  MAX_FEE_RECIPIENTS,
  MAX_SINGLE_RECIPIENT_BPS,
  MAX_TOTAL_FEE_BPS,
} from './constants.js';
import { type FeeRecipient, RecipientKind } from './types.js';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export class InvalidFeeRecipientsError extends Error {
  constructor(msg: string) {
    super(`InvalidFeeRecipients: ${msg}`);
    this.name = 'InvalidFeeRecipientsError';
  }
}
export class BpsSumExceedsCapError extends Error {
  constructor(sum: number) {
    super(`BpsSumExceedsCap: sum=${sum} cap=${MAX_TOTAL_FEE_BPS}`);
    this.name = 'BpsSumExceedsCapError';
  }
}
export class TreasuryCardinalityError extends Error {
  constructor(count: number) {
    super(
      `TreasuryCardinalityViolation: ${count} treasury recipients (must be exactly 1)`,
    );
    this.name = 'TreasuryCardinalityError';
  }
}
export class TreasuryBpsZeroError extends Error {
  constructor() {
    super('TreasuryBpsZero: the Treasury recipient must have bps > 0');
    this.name = 'TreasuryBpsZeroError';
  }
}

/**
 * Client-side mirror of `PactCore._validateFeeRecipients`. Run BEFORE
 * submitting an admin tx so the caller gets a precise error instead of a
 * generic revert. Rule-for-rule with the contract (incl. round-2 I1/I2 +
 * `TreasuryBpsZero`):
 *
 *  1. length in 1..=MAX_FEE_RECIPIENTS
 *  2. destination != address(0)
 *  3. per-entry bps <= MAX_SINGLE_RECIPIENT_BPS (10_000)
 *  4. exactly one Treasury recipient
 *  5. Treasury bps > 0
 *  6. no duplicate destinations (case-insensitive)
 *  7. Σ bps <= MAX_TOTAL_FEE_BPS (3_000)
 */
export function validateFeeRecipients(recipients: FeeRecipient[]): void {
  if (recipients.length === 0) {
    throw new InvalidFeeRecipientsError('at least one recipient required');
  }
  if (recipients.length > MAX_FEE_RECIPIENTS) {
    throw new InvalidFeeRecipientsError(
      `max ${MAX_FEE_RECIPIENTS} recipients, got ${recipients.length}`,
    );
  }

  const seen = new Set<string>();
  let treasuryCount = 0;
  let treasuryBps = 0;
  let sum = 0;

  for (const r of recipients) {
    if (r.destination.toLowerCase() === ZERO_ADDR) {
      throw new InvalidFeeRecipientsError('destination is the zero address');
    }
    if (r.bps < 0 || r.bps > MAX_SINGLE_RECIPIENT_BPS) {
      throw new InvalidFeeRecipientsError(
        `per-entry bps out of range: ${r.bps} (max ${MAX_SINGLE_RECIPIENT_BPS})`,
      );
    }

    const key = r.destination.toLowerCase();
    if (seen.has(key)) {
      throw new InvalidFeeRecipientsError(
        `duplicate destination ${r.destination}`,
      );
    }
    seen.add(key);

    if (r.kind === RecipientKind.Treasury) {
      treasuryCount += 1;
      treasuryBps = r.bps;
    }
    sum += r.bps;
  }

  if (treasuryCount !== 1) throw new TreasuryCardinalityError(treasuryCount);
  if (treasuryBps === 0) throw new TreasuryBpsZeroError();
  if (sum > MAX_TOTAL_FEE_BPS) throw new BpsSumExceedsCapError(sum);
}
