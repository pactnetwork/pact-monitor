import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { ProjectionService } from '../projection/projection.service';

const TREASURY_KIND = 0;

export interface IntegratorStat {
  recipientAddress: string;
  recipientKind: number;
  lifetimeEarnedWei: string;
}

export interface NetworkStats {
  totalPools: number;
  totalCoverageWei: string;
  totalPremiumsCollected: string;
  totalFeesPaid: string;
  totalRefundsPaid: string;
  totalTreasuryEarned: string;
  topIntegrators: IntegratorStat[];
  protocolPaused: boolean;

  totalCalls: number;
  totalBreaches: number;
  breachRateBps: number;
  totalDepositsWei: string;
  endpointCount: number;
  agentCount: number;
  updatedAt: string;
}

@Injectable()
export class StatsService {
  private cache: NetworkStats | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5_000;
  private readonly TOP_N = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
  ) {}

  async getStats(): Promise<NetworkStats> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) return this.cache;

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
        _sum: { premiumWei: true, refundWei: true },
      }),
      this.prisma.call.count({ where: { breach: true } }),
      this.prisma.endpoint.count(),
      this.prisma.agent.count(),
      this.prisma.poolState.findMany(),
      this.prisma.recipientEarnings.aggregate({
        where: { recipientKind: TREASURY_KIND },
        _sum: { lifetimeEarnedWei: true },
      }),
      // groupBy recipientAddress: a recipient has one row per slug under the
      // composite PK — group to preserve per-recipient ranking semantics.
      this.prisma.recipientEarnings.groupBy({
        by: ['recipientAddress'],
        where: { recipientKind: { not: TREASURY_KIND } },
        _sum: { lifetimeEarnedWei: true },
        orderBy: { _sum: { lifetimeEarnedWei: 'desc' } },
        take: this.TOP_N,
      }),
    ]);

    const sum = (xs: bigint[]) => xs.reduce((s, v) => s + v, 0n);
    const totalCoverage = sum(pools.map((p) => p.currentBalanceWei));
    const totalPremiums = sum(pools.map((p) => p.totalPremiumsWei));
    const totalFees = sum(pools.map((p) => p.totalFeesPaidWei));
    const totalRefunds = sum(pools.map((p) => p.totalRefundsWei));
    const totalDeposits = sum(pools.map((p) => p.totalDepositsWei));
    const totalCalls = callAgg._count.callId;

    const stats: NetworkStats = {
      totalPools: pools.length,
      totalCoverageWei: totalCoverage.toString(),
      totalPremiumsCollected: totalPremiums.toString(),
      totalFeesPaid: totalFees.toString(),
      totalRefundsPaid: totalRefunds.toString(),
      totalTreasuryEarned: (
        treasuryAgg._sum.lifetimeEarnedWei ?? 0n
      ).toString(),
      topIntegrators: topIntegrators.map((r) => ({
        recipientAddress: r.recipientAddress,
        recipientKind: 1,
        lifetimeEarnedWei: (r._sum.lifetimeEarnedWei ?? 0n).toString(),
      })),
      protocolPaused: this.projection.protocolPaused,
      totalCalls,
      totalBreaches: breachCount,
      breachRateBps:
        totalCalls > 0 ? Math.round((breachCount / totalCalls) * 10_000) : 0,
      totalDepositsWei: totalDeposits.toString(),
      endpointCount,
      agentCount,
      updatedAt: new Date().toISOString(),
    };

    this.cache = stats;
    this.cacheExpiresAt = now + this.CACHE_TTL_MS;
    return stats;
  }

  invalidate(): void {
    this.cache = null;
  }
}
