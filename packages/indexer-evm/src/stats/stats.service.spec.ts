import { describe, it, expect, vi } from 'vitest';
import { StatsService } from './stats.service';
import type { PrismaService } from '../db/prisma.service';
import type { ProjectionService } from '../projection/projection.service';

function svc(paused = false) {
  const prisma = {
    call: {
      aggregate: vi.fn().mockResolvedValue({
        _count: { callId: 4 },
        _sum: { premiumWei: 4000n, refundWei: 100n },
      }),
      count: vi.fn().mockResolvedValue(1),
    },
    endpoint: { count: vi.fn().mockResolvedValue(2) },
    agent: { count: vi.fn().mockResolvedValue(3) },
    poolState: {
      findMany: vi.fn().mockResolvedValue([
        {
          currentBalanceWei: 700n,
          totalDepositsWei: 10_000n,
          totalPremiumsWei: 1000n,
          totalFeesPaidWei: 300n,
          totalRefundsWei: 0n,
        },
      ]),
    },
    recipientEarnings: {
      aggregate: vi.fn().mockResolvedValue({
        _sum: { lifetimeEarnedWei: 250n },
      }),
      groupBy: vi.fn().mockResolvedValue([
        { recipientAddress: '0xaff', _sum: { lifetimeEarnedWei: 99n } },
      ]),
    },
  } as unknown as PrismaService;
  const projection = { protocolPaused: paused } as unknown as ProjectionService;
  return new StatsService(prisma, projection);
}

describe('StatsService', () => {
  it('aggregates pools, treasury, breach rate, protocolPaused', async () => {
    const s = await svc(true).getStats();
    expect(s.totalPools).toBe(1);
    expect(s.totalCoverageWei).toBe('700');
    expect(s.totalFeesPaid).toBe('300');
    expect(s.totalTreasuryEarned).toBe('250');
    expect(s.breachRateBps).toBe(2500); // 1/4
    expect(s.protocolPaused).toBe(true);
    expect(s.topIntegrators).toEqual([
      { recipientAddress: '0xaff', recipientKind: 1, lifetimeEarnedWei: '99' },
    ]);
  });

  it('caches within the 5s TTL (no second prisma hit)', async () => {
    const s = svc();
    const a = await s.getStats();
    const b = await s.getStats();
    expect(a).toBe(b);
  });
});
