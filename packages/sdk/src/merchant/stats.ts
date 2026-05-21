/**
 * `merchant.stats()` — wraps `GET /api/v1/merchants/me/stats`. The Commit 1
 * backend stub returns zeros; Commit 2 wires real aggregation once
 * `origin='merchant'` rows are joined to the settler pipeline.
 */
import type { MerchantClient } from "./client.js";

export interface MerchantStats {
  calls: number;
  failureRate: number;
  tier: string;
  premiumsCollectedUsdc: bigint;
  refundsPaidUsdc: bigint;
  netRevenueUsdc: bigint;
}

const ZEROED: MerchantStats = {
  calls: 0,
  failureRate: 0,
  tier: "UNRANKED",
  premiumsCollectedUsdc: 0n,
  refundsPaidUsdc: 0n,
  netRevenueUsdc: 0n,
};

function bigOrZero(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return 0n;
}

export async function fetchStats(
  client: MerchantClient,
  opts?: { since?: number },
): Promise<MerchantStats> {
  const query: Record<string, string | number> = {};
  if (opts?.since) query.since = opts.since;
  let raw: unknown;
  try {
    raw = await client.getStats(query);
  } catch {
    return { ...ZEROED };
  }
  if (!raw || typeof raw !== "object") return { ...ZEROED };
  const r = raw as Record<string, unknown>;
  return {
    calls: typeof r.calls === "number" ? r.calls : 0,
    failureRate: typeof r.failureRate === "number" ? r.failureRate : 0,
    tier: typeof r.tier === "string" ? r.tier : "UNRANKED",
    premiumsCollectedUsdc: bigOrZero(r.premiumsCollectedUsdc),
    refundsPaidUsdc: bigOrZero(r.refundsPaidUsdc),
    netRevenueUsdc: bigOrZero(r.netRevenueUsdc),
  };
}
