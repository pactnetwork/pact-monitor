import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// FeeRecipientKind values from the layered protocol.
const FEE_RECIPIENT_TREASURY = 0;

export interface IntegratorStat {
  recipientPubkey: string;
  recipientKind: number;
  lifetimeEarnedLamports: string;
}

export interface NetworkStats {
  /** Aggregate across all per-endpoint pools. */
  totalPools: number;
  totalCoverageLamports: string;
  /** Gross premiums collected (pre-fee). */
  totalPremiumsCollected: string;
  totalRefundsPaid: string;
  /** Sum of fee outflows to Treasury. */
  totalTreasuryEarned: string;
  /** Top-N integrators (any non-treasury recipient) by lifetime earnings. */
  topIntegrators: IntegratorStat[];

  // Legacy fields kept for back-compat with existing dashboards.
  totalCalls: number;
  totalBreaches: number;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  breachRateBps: number;
  poolBalanceLamports: string;
  totalDepositsLamports: string;
  endpointCount: number;
  agentCount: number;
  updatedAt: string;
}

@Injectable()
export class StatsService {
  private cache: NetworkStats | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5_000;
  private readonly TOP_INTEGRATORS_N = 10;

  constructor(private readonly prisma: PrismaService) {}

  async getStats(): Promise<NetworkStats> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }

    const [
      callAgg,
      breachCount,
      endpointCount,
      agentCount,
      pools,
      treasuryAgg,
      topIntegrators,
    ] = await Promise.all([
      this.prisma.call.aggregate({
        _count: { callId: true },
        _sum: { premiumLamports: true, refundLamports: true },
      }),
      this.prisma.call.count({ where: { breach: true } }),
      this.prisma.endpoint.count(),
      this.prisma.agent.count(),
      this.prisma.poolState.findMany(),
      this.prisma.recipientEarnings.aggregate({
        where: { recipientKind: FEE_RECIPIENT_TREASURY },
        _sum: { lifetimeEarnedLamports: true },
      }),
      this.prisma.recipientEarnings.findMany({
        where: { recipientKind: { not: FEE_RECIPIENT_TREASURY } },
        orderBy: { lifetimeEarnedLamports: "desc" },
        take: this.TOP_INTEGRATORS_N,
      }),
    ]);

    const totalCalls = callAgg._count.callId;
    const breachRateBps =
      totalCalls > 0 ? Math.round((breachCount / totalCalls) * 10_000) : 0;

    // Aggregate-across-pools sums.
    const totalCoverage = pools.reduce(
      (s, p) => s + p.currentBalanceLamports,
      0n,
    );
    const totalPremiumsCollected = pools.reduce(
      (s, p) => s + p.totalPremiumsLamports,
      0n,
    );
    const totalRefundsPaid = pools.reduce(
      (s, p) => s + p.totalRefundsLamports,
      0n,
    );
    const totalDeposits = pools.reduce(
      (s, p) => s + p.totalDepositsLamports,
      0n,
    );

    const totalTreasuryEarned =
      treasuryAgg._sum.lifetimeEarnedLamports ?? 0n;

    const stats: NetworkStats = {
      totalPools: pools.length,
      totalCoverageLamports: totalCoverage.toString(),
      totalPremiumsCollected: totalPremiumsCollected.toString(),
      totalRefundsPaid: totalRefundsPaid.toString(),
      totalTreasuryEarned: totalTreasuryEarned.toString(),
      topIntegrators: topIntegrators.map((r) => ({
        recipientPubkey: r.recipientPubkey,
        recipientKind: r.recipientKind,
        lifetimeEarnedLamports: r.lifetimeEarnedLamports.toString(),
      })),
      // Legacy fields.
      totalCalls,
      totalBreaches: breachCount,
      totalPremiumsLamports: (callAgg._sum.premiumLamports ?? 0n).toString(),
      totalRefundsLamports: (callAgg._sum.refundLamports ?? 0n).toString(),
      breachRateBps,
      poolBalanceLamports: totalCoverage.toString(),
      totalDepositsLamports: totalDeposits.toString(),
      endpointCount,
      agentCount,
      updatedAt: new Date().toISOString(),
    };

    this.cache = stats;
    this.cacheExpiresAt = now + this.CACHE_TTL_MS;
    return stats;
  }

  invalidate() {
    this.cache = null;
  }
}
