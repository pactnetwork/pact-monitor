/**
 * Aggregation helper backing `GET /api/v1/merchants/me/referrals` (Commit 3 K4).
 *
 * Sums claims paid out under a referrer's attribution window. The join to
 * api_keys.label maps `claims.agent_id` (denormalized label) to the agent's
 * actual pubkey — which is what the SDK `byAgent[].agentPubkey` field
 * promises. Refund amounts are micro-USDC (BIGINT in the schema); we
 * serialize as decimal-string so consumers can BigInt() without precision
 * loss across the JSON boundary.
 *
 * 30-day default window matches the existing partners route at
 * `routes/partners.ts` so the two surfaces don't drift on time-bounding
 * policy (they answer different questions over the same column).
 */
import { getMany, getOne } from "../db.js";

export interface ReferralAgentEntry {
  agentPubkey: string;
  calls: number;
  refShareUsdc: string;
}

export interface ReferralAggregation {
  totalRefShareUsdc: string;
  byAgent: ReferralAgentEntry[];
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function getReferralsForReferrer(
  referrerPubkey: string,
  since?: Date,
): Promise<ReferralAggregation> {
  const sinceTs = since ?? new Date(Date.now() - DEFAULT_WINDOW_MS);

  // Per-agent breakdown: join claims to api_keys to surface the agent's
  // pubkey (not just its label). LEFT JOIN so claims attributed to an
  // api_keys row that was later deleted still show up (under agent_pubkey
  // = NULL, which we filter out).
  const rows = await getMany<{
    agent_pubkey: string | null;
    calls: string; // pg returns COUNT(*) as text
    ref_share_usdc: string;
  }>(
    `SELECT ak.agent_pubkey,
            COUNT(*)::text AS calls,
            COALESCE(SUM(c.refund_amount), 0)::text AS ref_share_usdc
       FROM claims c
       LEFT JOIN api_keys ak ON ak.label = c.agent_id
      WHERE c.referrer_pubkey = $1
        AND c.created_at >= $2
        AND ak.agent_pubkey IS NOT NULL
      GROUP BY ak.agent_pubkey`,
    [referrerPubkey, sinceTs],
  );

  // Scalar total. A separate query (rather than reducing the per-agent
  // rows) so a future where claims are attributed to deleted keys still
  // reflects in the total — defense-in-depth, matches the partners route.
  const total = await getOne<{ total: string }>(
    `SELECT COALESCE(SUM(refund_amount), 0)::text AS total
       FROM claims
      WHERE referrer_pubkey = $1
        AND created_at >= $2`,
    [referrerPubkey, sinceTs],
  );

  return {
    totalRefShareUsdc: total?.total ?? "0",
    byAgent: rows.map((r) => ({
      agentPubkey: r.agent_pubkey!,
      calls: parseInt(r.calls, 10),
      refShareUsdc: r.ref_share_usdc,
    })),
  };
}
