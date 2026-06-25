/**
 * `merchant.referralLink()` + `merchant.referrals()` (Commit 3 K4).
 *
 * referralLink is deterministic — a URL that, when an agent follows it
 * through the self-serve issuance flow, threads `?ref=<merchantPubkey>`
 * into `POST /api/v1/keys/self-serve` and snapshots the referrer onto the
 * new agent api_keys row (Commit 3 K1 backend path).
 *
 * referrals() aggregates revshare attributed to the merchant from
 * `GET /api/v1/merchants/me/referrals` (Commit 3 K4 backend route). Returns
 * the zeroed shape on any network/parse failure — the merchant SDK's golden
 * rule mirrors the agent SDK's: backend hiccups surface in the shape, not
 * as exceptions.
 */
import type { MerchantClient } from "./client.js";
import { bigOrZero } from "./bignum.js";

export interface MerchantReferrals {
  totalRefShareUsdc: bigint;
  byAgent: Array<{ agentPubkey: string; calls: number; refShareUsdc: bigint }>;
}

const ZEROED: MerchantReferrals = {
  totalRefShareUsdc: 0n,
  byAgent: [],
};

export function buildReferralLink(
  merchantPubkey: string,
  baseUrl = "https://pactnetwork.io/onboard",
): string {
  return `${baseUrl}?ref=${encodeURIComponent(merchantPubkey)}`;
}

export async function fetchReferrals(
  client: MerchantClient,
  opts?: { since?: number },
): Promise<MerchantReferrals> {
  let raw: unknown;
  try {
    raw = await client.getReferrals(opts?.since);
  } catch {
    return { ...ZEROED };
  }
  if (!raw || typeof raw !== "object") return { ...ZEROED };
  const r = raw as Record<string, unknown>;
  const byAgentRaw = Array.isArray(r.byAgent) ? r.byAgent : [];
  return {
    totalRefShareUsdc: bigOrZero(r.totalRefShareUsdc),
    byAgent: byAgentRaw.map((a) => {
      const e = a as Record<string, unknown>;
      return {
        agentPubkey: typeof e.agentPubkey === "string" ? e.agentPubkey : "",
        calls: typeof e.calls === "number" ? e.calls : 0,
        refShareUsdc: bigOrZero(e.refShareUsdc),
      };
    }),
  };
}
