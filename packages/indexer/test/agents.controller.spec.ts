import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AgentsController } from "../src/api/agents.controller";
import { PrismaService } from "../src/prisma/prisma.service";

const PUBKEY = "AgentPubkey1111111111111111111111111111111111";

const makeAgentRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  pubkey: PUBKEY,
  displayName: null,
  totalPremiumsLamports: 1500n,
  totalRefundsLamports: 0n,
  callCount: 1n,
  lastCallAt: new Date("2026-05-07T12:00:00Z"),
  createdAt: new Date("2026-05-07T11:59:00Z"),
  ...overrides,
});

const makeCallRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  callId: "call-001",
  agentPubkey: PUBKEY,
  endpointSlug: "helius",
  premiumLamports: 1500n,
  refundLamports: 0n,
  latencyMs: 120,
  breach: false,
  breachReason: null,
  source: "wrap",
  ts: new Date("2026-05-07T12:00:00Z"),
  settledAt: new Date("2026-05-07T12:00:01Z"),
  signature: "sig111",
  ...overrides,
});

const makePrisma = () => {
  return {
    agent: {
      findUnique: jest.fn(async ({ where: { pubkey } }) => {
        if (pubkey === PUBKEY) return makeAgentRow();
        return null;
      }),
    },
    call: {
      findMany: jest.fn(
        async (args: { where: { agentPubkey: string }; take: number; orderBy: unknown }) => {
          if (args.where.agentPubkey !== PUBKEY) return [];
          return [makeCallRow()].slice(0, args.take);
        },
      ),
    },
  };
};

describe("AgentsController", () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  // Regression for the mainnet 500 on 2026-05-07: Prisma returns BigInt fields,
  // and Nest's default JSON serialiser throws "Do not know how to serialize a
  // BigInt" when there is at least one matching row. The fix is to stringify
  // BigInts at the controller boundary (same pattern as CallsController).
  it("GET /api/agents/:pubkey/calls serializes BigInt fields as strings", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/agents/${PUBKEY}/calls?limit=5`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(typeof res.body[0].premiumLamports).toBe("string");
    expect(res.body[0].premiumLamports).toBe("1500");
    expect(res.body[0].refundLamports).toBe("0");
    expect(res.body[0].callId).toBe("call-001");
  });

  it("GET /api/agents/:pubkey/calls returns [] for an agent with no calls", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/agents/UnknownAgent/calls")
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/agents/:pubkey/calls forwards default limit 50, capped at 200", async () => {
    await request(app.getHttpServer())
      .get(`/api/agents/${PUBKEY}/calls`)
      .expect(200);
    expect(prisma.call.findMany.mock.calls[0][0].take).toBe(50);

    await request(app.getHttpServer())
      .get(`/api/agents/${PUBKEY}/calls?limit=999`)
      .expect(200);
    expect(prisma.call.findMany.mock.calls[1][0].take).toBe(200);

    await request(app.getHttpServer())
      .get(`/api/agents/${PUBKEY}/calls?limit=garbage`)
      .expect(200);
    expect(prisma.call.findMany.mock.calls[2][0].take).toBe(50);
  });

  it("GET /api/agents/:pubkey/calls scopes the query by agentPubkey, ordered by ts DESC", async () => {
    await request(app.getHttpServer())
      .get(`/api/agents/${PUBKEY}/calls`)
      .expect(200);
    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ agentPubkey: PUBKEY });
    expect(args.orderBy).toEqual({ ts: "desc" });
  });

  it("GET /api/agents/:pubkey serializes the Agent's BigInt fields as strings", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/agents/${PUBKEY}`)
      .expect(200);
    expect(res.body.pubkey).toBe(PUBKEY);
    expect(typeof res.body.totalPremiumsLamports).toBe("string");
    expect(res.body.totalPremiumsLamports).toBe("1500");
    expect(res.body.totalRefundsLamports).toBe("0");
    expect(res.body.callCount).toBe("1");
  });

  it("GET /api/agents/:pubkey returns 404 when the agent is unknown", async () => {
    await request(app.getHttpServer())
      .get("/api/agents/UnknownAgent")
      .expect(404);
  });
});
