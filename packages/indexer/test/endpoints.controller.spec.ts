import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
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
  network: "solana-devnet",
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
          network: "arc-testnet",
          slug: "helius",
          displayName: "Helius (Arc)",
          // Same slug on a different network — exercises the disambiguation
          // case from G-8 (multi-network smoke combined report).
          poolState: null,
        }),
      ]),
    findUnique: jest.fn(async ({ where }) => {
      const slug = where.network_slug?.slug ?? where.slug;
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
    // G-8: network field must be included so clients can disambiguate
    // same-slug rows across chains. Endpoint PK is (network, slug).
    expect(helius.network).toBe("solana-devnet");
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
    const second = res.body[1];
    expect(second.slug).toBe("helius");
    // G-8: network distinguishes this row from the solana-devnet helius row.
    expect(second.network).toBe("arc-testnet");
    expect(second.pool).toBeNull();
    expect(second.feeRecipients).toEqual([]);
  });

  it("GET /api/endpoints disambiguates same-slug rows across networks (G-8)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/endpoints")
      .expect(200);
    const networks = res.body.map((r: { network: string }) => r.network);
    expect(networks).toEqual(["solana-devnet", "arc-testnet"]);
    // Both rows share slug=helius — the (network, slug) tuple is what
    // makes them distinct.
    const slugs = res.body.map((r: { slug: string }) => r.slug);
    expect(slugs).toEqual(["helius", "helius"]);
  });

  it("GET /api/endpoints/:slug includes pool aggregates", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/endpoints/helius")
      .expect(200);
    expect(res.body.slug).toBe("helius");
    // G-8: single-row endpoint response must also expose network.
    expect(res.body.network).toBe("solana-devnet");
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
