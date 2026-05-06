import { Test, TestingModule } from "@nestjs/testing";
import { StatsService, NetworkStats } from "../src/stats/stats.service";
import { PrismaService } from "../src/prisma/prisma.service";

const makePrisma = () => ({
  call: {
    aggregate: jest.fn().mockResolvedValue({
      _count: { callId: 10 },
      _sum: { premiumLamports: 5000n, refundLamports: 1000n },
    }),
    count: jest.fn().mockResolvedValue(2),
  },
  endpoint: { count: jest.fn().mockResolvedValue(3) },
  agent: { count: jest.fn().mockResolvedValue(5) },
  poolState: {
    findMany: jest.fn().mockResolvedValue([
      {
        endpointSlug: "helius",
        currentBalanceLamports: 3000n,
        totalDepositsLamports: 60000n,
        totalPremiumsLamports: 4000n,
        totalFeesPaidLamports: 400n,
        totalRefundsLamports: 600n,
        lastUpdated: new Date(),
      },
      {
        endpointSlug: "birdeye",
        currentBalanceLamports: 1000n,
        totalDepositsLamports: 40000n,
        totalPremiumsLamports: 1500n,
        totalFeesPaidLamports: 100n,
        totalRefundsLamports: 400n,
        lastUpdated: new Date(),
      },
    ]),
  },
  recipientEarnings: {
    aggregate: jest.fn().mockResolvedValue({
      _sum: { lifetimeEarnedLamports: 500n },
    }),
    findMany: jest.fn().mockResolvedValue([
      {
        recipientPubkey: "AffiliateA111111111111111111111111111111111",
        recipientKind: 1,
        lifetimeEarnedLamports: 800n,
      },
      {
        recipientPubkey: "AffiliateB222222222222222222222222222222222",
        recipientKind: 2,
        lifetimeEarnedLamports: 200n,
      },
    ]),
  },
});

describe("StatsService", () => {
  let service: StatsService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(StatsService);
  });

  it("getStats aggregates across pools (totals are summed)", async () => {
    const stats: NetworkStats = await service.getStats();
    // 3000 + 1000 = 4000
    expect(stats.totalCoverageLamports).toBe("4000");
    // 4000 + 1500 = 5500
    expect(stats.totalPremiumsCollected).toBe("5500");
    // 600 + 400 = 1000
    expect(stats.totalRefundsPaid).toBe("1000");
    expect(stats.totalPools).toBe(2);
    // Treasury sum from recipientEarnings.aggregate
    expect(stats.totalTreasuryEarned).toBe("500");
  });

  it("getStats returns top integrators ordered by lifetime earnings", async () => {
    const stats = await service.getStats();
    expect(stats.topIntegrators).toHaveLength(2);
    expect(stats.topIntegrators[0].lifetimeEarnedLamports).toBe("800");
    expect(stats.topIntegrators[0].recipientKind).toBe(1);
    expect(stats.topIntegrators[1].recipientKind).toBe(2);
    // Verify Treasury (kind=0) is excluded from integrators query.
    const findManyCall = prisma.recipientEarnings.findMany.mock.calls[0][0];
    expect(findManyCall.where.recipientKind).toEqual({ not: 0 });
  });

  it("getStats keeps legacy fields populated for back-compat", async () => {
    const stats = await service.getStats();
    expect(stats.totalCalls).toBe(10);
    expect(stats.totalBreaches).toBe(2);
    expect(stats.breachRateBps).toBe(2000);
    expect(stats.totalPremiumsLamports).toBe("5000");
    expect(stats.totalRefundsLamports).toBe("1000");
    expect(stats.poolBalanceLamports).toBe("4000");
    expect(stats.endpointCount).toBe(3);
    expect(stats.agentCount).toBe(5);
  });

  it("getStats returns cached result within 5s TTL", async () => {
    await service.getStats();
    await service.getStats();
    expect(prisma.call.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.poolState.findMany).toHaveBeenCalledTimes(1);
  });

  it("getStats refreshes after invalidate()", async () => {
    await service.getStats();
    service.invalidate();
    await service.getStats();
    expect(prisma.call.aggregate).toHaveBeenCalledTimes(2);
  });

  it("handles empty pools list (returns zero strings)", async () => {
    prisma.poolState.findMany.mockResolvedValueOnce([]);
    prisma.recipientEarnings.aggregate.mockResolvedValueOnce({
      _sum: { lifetimeEarnedLamports: null },
    });
    prisma.recipientEarnings.findMany.mockResolvedValueOnce([]);
    service.invalidate();
    const stats = await service.getStats();
    expect(stats.totalPools).toBe(0);
    expect(stats.totalCoverageLamports).toBe("0");
    expect(stats.totalPremiumsCollected).toBe("0");
    expect(stats.totalRefundsPaid).toBe("0");
    expect(stats.totalTreasuryEarned).toBe("0");
    expect(stats.topIntegrators).toEqual([]);
  });
});
