import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { EndpointsController } from "../src/api/endpoints.controller";
import { PrismaService } from "../src/prisma/prisma.service";

const makePoolState = (overrides: Partial<Record<string, unknown>> = {}) => ({
  endpointSlug: "helius",
  currentBalanceLamports: 3000n,
  totalDepositsLamports: 60000n,
  totalPremiumsLamports: 4000n,
  totalFeesPaidLamports: 400n,
  totalRefundsLamports: 600n,
  lastUpdated: new Date("2026-04-01T00:00:00Z"),
  ...overrides,
});

const makeEndpoint = (overrides: Partial<Record<string, unknown>> = {}) => ({
  slug: "helius",
  flatPremiumLamports: 1000n,
  percentBps: 50,
  slaLatencyMs: 800,
  imputedCostLamports: 5000n,
  exposureCapPerHourLamports: 100000n,
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  displayName: "Helius",
  logoUrl: null,
  registeredAt: new Date("2026-03-01T00:00:00Z"),
  lastUpdated: new Date("2026-04-01T00:00:00Z"),
  poolState: makePoolState(),
  ...overrides,
});

const makePrisma = () => ({
  endpoint: {
    findMany: jest
      .fn()
      .mockResolvedValue([
        makeEndpoint(),
        makeEndpoint({
          slug: "birdeye",
          displayName: "Birdeye",
          // No PoolState yet for this endpoint (lazy-create on first ingest).
          poolState: null,
        }),
      ]),
    findUnique: jest.fn(async ({ where: { slug } }) => {
      if (slug === "helius") return makeEndpoint();
      if (slug === "fresh")
        return makeEndpoint({ slug: "fresh", poolState: null });
      return null;
    }),
  },
});

describe("EndpointsController", () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EndpointsController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  it("GET /api/endpoints includes joined pool aggregates and feeRecipients", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/endpoints")
      .expect(200);
    expect(res.body).toHaveLength(2);
    const helius = res.body[0];
    expect(helius.slug).toBe("helius");
    // BigInts are emitted as decimal strings.
    expect(helius.flatPremiumLamports).toBe("1000");
    expect(helius.pool).toEqual(
      expect.objectContaining({
        currentBalanceLamports: "3000",
        totalDepositsLamports: "60000",
        totalPremiumsLamports: "4000",
        totalFeesPaidLamports: "400",
        totalRefundsLamports: "600",
      }),
    );
    // Empty until on-chain registration sync lands.
    expect(helius.feeRecipients).toEqual([]);
    // Verify Prisma was asked to include PoolState.
    const args = prisma.endpoint.findMany.mock.calls[0][0];
    expect(args.include).toEqual({ poolState: true });
  });

  it("GET /api/endpoints emits pool=null when no PoolState exists", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/endpoints")
      .expect(200);
    const birdeye = res.body[1];
    expect(birdeye.slug).toBe("birdeye");
    expect(birdeye.pool).toBeNull();
    expect(birdeye.feeRecipients).toEqual([]);
  });

  it("GET /api/endpoints/:slug includes pool aggregates", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/endpoints/helius")
      .expect(200);
    expect(res.body.slug).toBe("helius");
    expect(res.body.pool.totalPremiumsLamports).toBe("4000");
    expect(res.body.feeRecipients).toEqual([]);
    const args = prisma.endpoint.findUnique.mock.calls[0][0];
    expect(args.include).toEqual({ poolState: true });
  });

  it("GET /api/endpoints/:slug emits pool=null for fresh endpoints", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/endpoints/fresh")
      .expect(200);
    expect(res.body.pool).toBeNull();
  });

  it("GET /api/endpoints/:slug returns 404 for unknown slug", async () => {
    await request(app.getHttpServer())
      .get("/api/endpoints/does-not-exist")
      .expect(404);
  });

  it("preserves backward-compat scalar columns for legacy clients", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/endpoints/helius")
      .expect(200);
    // The dashboard still parses these — see lib/api/real.ts mapEndpoint.
    expect(res.body).toEqual(
      expect.objectContaining({
        slug: "helius",
        displayName: "Helius",
        upstreamBase: "https://mainnet.helius-rpc.com",
        slaLatencyMs: 800,
        percentBps: 50,
        paused: false,
      }),
    );
  });
});
