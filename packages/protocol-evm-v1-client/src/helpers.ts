/**
 * Higher-level helpers — the EVM analogue of
 * `protocol-v1-client/src/helpers.ts` (design spec §5). D-D (captain GATE-A
 * APPROVED): only the parity-relevant, chain-agnostic subset is mirrored:
 *
 * - `defaultFeeRecipients` — the V1 default fan-out template.
 * - `validateFeeRecipients` — mirrors the on-chain `fee.rs` invariants (and
 *   `FeeValidation.sol`) so callers can pre-flight before a revert.
 *
 * The Solana `accountListForBatch` / `feeAtasMatchEndpoint` /
 * `getAgentInsurableState` helpers are SPL-account / ATA / PDA mechanics with
 * no EVM equivalent (design spec §4 #2/#7): there is no per-event account
 * list (slug-keyed mappings), and agent custody is a one-line ERC-20
 * `approve(PactSettler, n)` — no PDA delegate helper is needed. These are
 * recorded N-A-ON-EVM in the WP-EVM-06 parity matrix.
 */
import { type Address } from "viem";

import { ABSOLUTE_FEE_BPS_CAP, MAX_FEE_RECIPIENTS } from "./constants.js";
import { FeeRecipientKind, type FeeRecipient } from "./state.js";

/**
 * V1 default `feeRecipients` template.
 * - No affiliate: `[Treasury 10%]` (count 1).
 * - With affiliate: `[Treasury 10%, Affiliate 5%]` (count 2).
 *
 * Mirrors the Solana `defaultFeeRecipients` (bps 1000 / 500). On EVM an
 * affiliate is a plain address (§4 #7) — `AffiliateAta` kind preserved on the
 * wire for indexer parity.
 */
export function defaultFeeRecipients(
  treasuryVault: Address | string,
  affiliate?: Address | string,
): { feeRecipients: FeeRecipient[]; feeRecipientCount: number } {
  const feeRecipients: FeeRecipient[] = [
    {
      kind: FeeRecipientKind.Treasury,
      destination: treasuryVault as Address,
      bps: 1000,
    },
  ];
  if (affiliate) {
    feeRecipients.push({
      kind: FeeRecipientKind.AffiliateAta,
      destination: affiliate as Address,
      bps: 500,
    });
  }
  return { feeRecipients, feeRecipientCount: feeRecipients.length };
}

/**
 * Run the same invariants the on-chain program enforces in
 * `fee.rs::parse_and_validate` / `FeeValidation.sol`, in the SAME order, so a
 * caller can pre-flight without hitting a revert. Returns the first failure.
 * The duplicate-destination check is case-insensitive (EVM addresses compare
 * by value, not by checksum casing).
 */
export function validateFeeRecipients(
  recipients: FeeRecipient[],
  count: number,
  maxTotalFeeBps: number,
): { valid: boolean; reason?: string } {
  if (count !== recipients.length) {
    return {
      valid: false,
      reason: `count (${count}) must equal recipients.length (${recipients.length})`,
    };
  }
  if (count > MAX_FEE_RECIPIENTS) {
    return {
      valid: false,
      reason: `FeeRecipientArrayTooLong: ${count} > ${MAX_FEE_RECIPIENTS}`,
    };
  }
  if (maxTotalFeeBps > ABSOLUTE_FEE_BPS_CAP) {
    return {
      valid: false,
      reason: `FeeBpsExceedsCap: maxTotalFeeBps (${maxTotalFeeBps}) > ${ABSOLUTE_FEE_BPS_CAP}`,
    };
  }
  let sum = 0;
  let treasurySeen = false;
  const seenDest = new Set<string>();
  for (const r of recipients) {
    if (
      r.kind !== FeeRecipientKind.Treasury &&
      r.kind !== FeeRecipientKind.AffiliateAta &&
      r.kind !== FeeRecipientKind.AffiliatePda
    ) {
      return { valid: false, reason: `InvalidFeeRecipientKind: ${r.kind}` };
    }
    if (r.bps > ABSOLUTE_FEE_BPS_CAP) {
      return {
        valid: false,
        reason: `FeeBpsExceedsCap: entry bps (${r.bps}) > ${ABSOLUTE_FEE_BPS_CAP}`,
      };
    }
    if (r.kind === FeeRecipientKind.Treasury) {
      if (treasurySeen) {
        return { valid: false, reason: "MultipleTreasuryRecipients" };
      }
      treasurySeen = true;
    }
    const dest = String(r.destination).toLowerCase();
    if (seenDest.has(dest)) {
      return {
        valid: false,
        reason: `FeeRecipientDuplicateDestination: ${r.destination}`,
      };
    }
    seenDest.add(dest);
    sum += r.bps;
  }
  if (sum > ABSOLUTE_FEE_BPS_CAP) {
    return { valid: false, reason: `FeeBpsSumOver10k: sum=${sum}` };
  }
  if (sum > maxTotalFeeBps) {
    return {
      valid: false,
      reason: `FeeBpsExceedsCap: sum (${sum}) > maxTotalFeeBps (${maxTotalFeeBps})`,
    };
  }
  return { valid: true };
}
