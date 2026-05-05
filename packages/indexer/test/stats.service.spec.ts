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
    findUnique: jest.fn().mockResolvedValue({
      currentBalanceLamports: 4000n,
      totalDepositsLamports: 100000n,
    }),
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

  it("getStats returns correct aggregates", async () => {
    const stats: NetworkStats = await service.getStats();
    expect(stats.totalCalls).toBe(10);
    expect(stats.totalBreaches).toBe(2);
    expect(stats.breachRateBps).toBe(2000); // 2/10 * 10000
    expect(stats.totalPremiumsLamports).toBe("5000");
    expect(stats.totalRefundsLamports).toBe("1000");
    expect(stats.poolBalanceLamports).toBe("4000");
    expect(stats.endpointCount).toBe(3);
    expect(stats.agentCount).toBe(5);
  });

  it("getStats returns cached result within 5s TTL", async () => {
    await service.getStats();
    await service.getStats();
    // Prisma aggregate should only be called once (cache hit on 2nd)
    expect(prisma.call.aggregate).toHaveBeenCalledTimes(1);
  });

  it("getStats refreshes after invalidate()", async () => {
    await service.getStats();
    service.invalidate();
    await service.getStats();
    expect(prisma.call.aggregate).toHaveBeenCalledTimes(2);
  });

  it("handles null pool state (returns zero strings)", async () => {
    prisma.poolState.findUnique.mockResolvedValueOnce(null);
    service.invalidate();
    const stats = await service.getStats();
    expect(stats.poolBalanceLamports).toBe("0");
    expect(stats.totalDepositsLamports).toBe("0");
  });
});
