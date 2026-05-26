/**
 * WP-MN-03a Task 5 — wire-compat e2e tests
 *
 * Exercises:
 *  1. `?network=` filter narrows Prisma queries on /api/calls
 *  2. Unknown network value → 400 BadRequest
 *  3. No ?network= param → aggregate (no Prisma where-filter)
 *  4. Legacy-default behaviour on GET /api/calls/:id (defaults to solana-devnet)
 *  5. GET /api/endpoints and /api/agents also honour the filter
 *
 * Uses mocked Prisma (same pattern as calls.controller.spec.ts) so no real DB
 * or full AppModule bootstrap is needed. @pact-network/shared is stubbed with a
 * minimal two-network set so the tests don't require chains.json on disk.
 */

// Stub @pact-network/shared BEFORE anything imports it.
// network-filter.ts calls listChains() at module scope, so the mock must be
// hoisted (jest.mock is hoisted automatically by ts-jest).
jest.mock("@pact-network/shared", () => ({
  listChains: () => [
    { network: "solana-devnet", vm: "solana" },
    { network: "solana-mainnet", vm: "solana" },
    { network: "arc-testnet", vm: "evm" },
  ],
}));

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";

import { CallsController } from "../src/api/calls.controller";
import { EndpointsController } from "../src/api/endpoints.controller";
import { AgentsController } from "../src/api/agents.controller";
import { PrismaService } from "../src/prisma/prisma.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeCallRow = (overrides: Record<string, unknown> = {}) => ({
  callId: "call-001",
  network: "solana-devnet",
  agentPubkey: "AgentPubkey1111111111111111111111111111111111",
  endpointSlug: "helius",
  premiumLamports: 500n,
  refundLamports: 0n,
  latencyMs: 120,
  breach: false,
  breachReason: null,
  source: "wrap",
  ts: new Date("2026-04-01T00:00:00Z"),
  settledAt: new Date("2026-04-01T00:00:01Z"),
  signature: "sig111",
  ...overrides,
});

const makeEndpointRow = (overrides: Record<string, unknown> = {}) => ({
  slug: "helius",
  network: "solana-devnet",
  displayName: "Helius",
  logoUrl: null,
  flatPremiumLamports: 500n,
  percentBps: 0,
  slaLatencyMs: 2000,
  imputedCostLamports: 0n,
  exposureCapPerHourLamports: 1_000_000n,
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  registeredAt: new Date("2026-04-01T00:00:00Z"),
  lastUpdated: new Date("2026-04-01T00:00:00Z"),
  poolState: null,
  ...overrides,
});

const makeAgentRow = () => ({
  pubkey: "AgentPubkey1111111111111111111111111111111111",
  displayName: null,
  totalPremiumsLamports: 1000n,
  totalRefundsLamports: 0n,
  callCount: 2n,
  lastCallAt: new Date("2026-04-01T00:00:00Z"),
  createdAt: new Date("2026-04-01T00:00:00Z"),
});

// ---------------------------------------------------------------------------
// Prisma mock factory — captures the `where` arg of the most recent findMany
// ---------------------------------------------------------------------------

function makePrisma(callRows = [makeCallRow()]) {
  return {
    call: {
      findMany: jest.fn(async (args: { where?: Record<string, unknown> }) =>
        // Filter in-memory by network if the where includes it
        callRows.filter((r) =>
          args.where?.network ? r.network === args.where.network : true,
        ),
      ),
      findUnique: jest.fn(
        async (args: { where: { network_callId: { network: string; callId: string } } }) => {
          const { network, callId } = args.where.network_callId;
          return (
            callRows.find((r) => r.network === network && r.callId === callId) ??
            null
          );
        },
      ),
    },
    settlementRecipientShare: {
      findMany: jest.fn(async () => []),
    },
    endpoint: {
      findMany: jest.fn(async (args: { where?: Record<string, unknown> }) =>
        [makeEndpointRow()].filter((r) =>
          args.where?.network ? r.network === args.where.network : true,
        ),
      ),
      findUnique: jest.fn(async () => makeEndpointRow()),
    },
    agent: {
      findUnique: jest.fn(async ({ where }: { where: { pubkey: string } }) =>
        where.pubkey === makeAgentRow().pubkey ? makeAgentRow() : null,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: spin up a minimal Nest app with selected controllers + mocked Prisma
// ---------------------------------------------------------------------------

async function buildApp(
  prisma: ReturnType<typeof makePrisma>,
): Promise<INestApplication> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [CallsController, EndpointsController, AgentsController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WP-MN-03a — wire compat: ?network= filter + legacy defaults", () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof makePrisma>;

  // Seed two calls on different networks so we can verify narrowing
  const solanaCall = makeCallRow({ callId: "call-solana", network: "solana-devnet" });
  const arcCall = makeCallRow({ callId: "call-arc", network: "arc-testnet" });

  beforeAll(async () => {
    prisma = makePrisma([solanaCall, arcCall]);
    app = await buildApp(prisma);
  });

  afterAll(async () => app.close());

  // 1. Filter narrows to the requested network
  it("GET /api/calls?network=solana-devnet returns only solana-devnet calls", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/calls?network=solana-devnet")
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    for (const call of res.body) {
      // network column is not in the wire shape, but we can check slug/callId
      expect(call.callId).toBe("call-solana");
    }
    // Confirm Prisma was called with the correct where clause
    const args = prisma.call.findMany.mock.calls.at(-1)![0];
    expect(args.where).toEqual({ network: "solana-devnet" });
  });

  // 2. Unknown network → 400
  it("GET /api/calls?network=unknown-chain returns 400", async () => {
    await request(app.getHttpServer())
      .get("/api/calls?network=unknown-chain")
      .expect(400);
  });

  // 3. No ?network= → aggregate (empty where)
  it("GET /api/calls without ?network= returns all calls (aggregate)", async () => {
    prisma.call.findMany.mockClear();
    const res = await request(app.getHttpServer())
      .get("/api/calls")
      .expect(200);

    expect(res.body).toHaveLength(2);
    const args = prisma.call.findMany.mock.calls[0][0];
    // where should be {} (no network filter)
    expect(args.where).toEqual({});
  });

  // 4. GET /api/calls/:id defaults to solana-devnet when no ?network=
  it("GET /api/calls/:id without ?network= uses solana-devnet composite key", async () => {
    prisma.call.findUnique.mockClear();
    await request(app.getHttpServer())
      .get("/api/calls/call-solana")
      .expect(200);

    const args = prisma.call.findUnique.mock.calls[0][0];
    expect(args.where.network_callId.network).toBe("solana-devnet");
    expect(args.where.network_callId.callId).toBe("call-solana");
  });

  // 5. GET /api/calls/:id with ?network=arc-testnet uses that network key
  it("GET /api/calls/:id?network=arc-testnet looks up using arc-testnet key", async () => {
    prisma.call.findUnique.mockClear();
    await request(app.getHttpServer())
      .get("/api/calls/call-arc?network=arc-testnet")
      .expect(200);

    const args = prisma.call.findUnique.mock.calls[0][0];
    expect(args.where.network_callId.network).toBe("arc-testnet");
  });

  // 6. Endpoints list narrows
  it("GET /api/endpoints?network=solana-devnet passes network to Prisma where", async () => {
    prisma.endpoint.findMany.mockClear();
    await request(app.getHttpServer())
      .get("/api/endpoints?network=solana-devnet")
      .expect(200);

    const args = prisma.endpoint.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ network: "solana-devnet" });
  });

  // 7. Endpoints list without network → empty where
  it("GET /api/endpoints without ?network= passes empty where (aggregate)", async () => {
    prisma.endpoint.findMany.mockClear();
    await request(app.getHttpServer())
      .get("/api/endpoints")
      .expect(200);

    const args = prisma.endpoint.findMany.mock.calls[0][0];
    expect(args.where).toEqual({});
  });

  // 8. Agent calls narrows
  it("GET /api/agents/:pubkey/calls?network=solana-devnet passes network to Prisma where", async () => {
    const pubkey = makeAgentRow().pubkey;
    prisma.call.findMany.mockClear();
    await request(app.getHttpServer())
      .get(`/api/agents/${pubkey}/calls?network=solana-devnet`)
      .expect(200);

    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ agentPubkey: pubkey, network: "solana-devnet" });
  });

  // 9. Agent calls without network → agentPubkey only in where
  it("GET /api/agents/:pubkey/calls without ?network= does not add network to where", async () => {
    const pubkey = makeAgentRow().pubkey;
    prisma.call.findMany.mockClear();
    await request(app.getHttpServer())
      .get(`/api/agents/${pubkey}/calls`)
      .expect(200);

    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ agentPubkey: pubkey });
  });

  // 10. Endpoints: unknown network → 400
  it("GET /api/endpoints?network=bad returns 400", async () => {
    await request(app.getHttpServer())
      .get("/api/endpoints?network=bad")
      .expect(400);
  });
});
