import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface NetworkStats {
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

  constructor(private readonly prisma: PrismaService) {}

  async getStats(): Promise<NetworkStats> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }

    const [callAgg, endpointCount, agentCount, pool] = await Promise.all([
      this.prisma.call.aggregate({
        _count: { callId: true },
        _sum: { premiumLamports: true, refundLamports: true },
      }),
      this.prisma.endpoint.count(),
      this.prisma.agent.count(),
      this.prisma.poolState.findUnique({ where: { id: 1 } }),
    ]);

    const breachCount = await this.prisma.call.count({
      where: { breach: true },
    });

    const totalCalls = callAgg._count.callId;
    const breachRateBps =
      totalCalls > 0 ? Math.round((breachCount / totalCalls) * 10_000) : 0;

    const stats: NetworkStats = {
      totalCalls,
      totalBreaches: breachCount,
      totalPremiumsLamports: (
        callAgg._sum.premiumLamports ?? 0n
      ).toString(),
      totalRefundsLamports: (
        callAgg._sum.refundLamports ?? 0n
      ).toString(),
      breachRateBps,
      poolBalanceLamports: (
        pool?.currentBalanceLamports ?? 0n
      ).toString(),
      totalDepositsLamports: (
        pool?.totalDepositsLamports ?? 0n
      ).toString(),
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
