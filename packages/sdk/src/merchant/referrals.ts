/**
 * `merchant.referralLink()` + `merchant.referrals()`. The link works today
 * (a deterministic URL based on the merchant pubkey); the aggregation call
 * lands in Commit 3 once self-serve issuance honors `?ref=<pubkey>`.
 */
import { PactError, PactErrorCode } from "../errors.js";

export interface MerchantReferrals {
  totalRefShareUsdc: bigint;
  byAgent: Array<{ agentPubkey: string; calls: number; refShareUsdc: bigint }>;
}

export function buildReferralLink(
  merchantPubkey: string,
  baseUrl = "https://pactnetwork.io/onboard",
): string {
  return `${baseUrl}?ref=${encodeURIComponent(merchantPubkey)}`;
}

export async function fetchReferrals(
  _opts?: { since?: number },
): Promise<MerchantReferrals> {
  throw new PactError(
    PactErrorCode.NOT_AVAILABLE,
    "merchant.referrals(): aggregation lands in Commit 3 (Phase K4) once self-serve issuance captures referrer_pubkey",
    { retryable: false },
  );
}
