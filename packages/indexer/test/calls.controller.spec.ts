import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { CallsController } from "../src/api/calls.controller";
import { PrismaService } from "../src/prisma/prisma.service";

const SIG = "sig111";
const OTHER_SIG = "sig222";

const makeShareRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "share-1",
  settlementSig: SIG,
  recipientKind: 0,
  recipientPubkey: "TreasuryPubkey11111111111111111111111111111",
  amountLamports: 50n,
  ...overrides,
});

const makeCallRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  callId: "call-001",
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
  signature: SIG,
  ...overrides,
});

const makePrisma = () => {
  const calls = [
    makeCallRow({
      callId: "call-recent-1",
      ts: new Date("2026-04-03T00:00:00Z"),
    }),
    makeCallRow({
      callId: "call-recent-2",
      ts: new Date("2026-04-02T00:00:00Z"),
    }),
    makeCallRow({
      callId: "call-recent-3",
      ts: new Date("2026-04-01T00:00:00Z"),
    }),
  ];
  return {
    call: {
      findMany: jest.fn(async (args: { take: number; orderBy: unknown }) =>
        calls.slice(0, args.take),
      ),
      findUnique: jest.fn(async ({ where: { callId } }) => {
        if (callId === "call-001") return makeCallRow();
        if (callId === "call-other-batch")
          return makeCallRow({
            callId: "call-other-batch",
            signature: OTHER_SIG,
          });
        return null;
      }),
    },
    settlementRecipientShare: {
      findMany: jest.fn(async ({ where }: { where: { settlementSig: string } }) => {
        if (where.settlementSig === SIG) {
          return [
            makeShareRow(),
            makeShareRow({
              id: "share-2",
              recipientKind: 1,
              recipientPubkey: "AffiliateA111111111111111111111111111111111",
              amountLamports: 25n,
            }),
          ];
        }
        return [];
      }),
    },
  };
};

describe("CallsController", () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CallsController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  it("GET /api/calls returns the most recent N calls (default limit 50)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/calls")
      .expect(200);
    // Three rows in the fixture, order preserved (DESC by ts).
    expect(res.body).toHaveLength(3);
    expect(res.body[0].callId).toBe("call-recent-1");
    expect(res.body[2].callId).toBe("call-recent-3");
    // Default limit is 50 and the controller forwards it to Prisma.
    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.take).toBe(50);
    expect(args.orderBy).toEqual({ ts: "desc" });
  });

  it("GET /api/calls?limit=10 respects the requested limit", async () => {
    await request(app.getHttpServer()).get("/api/calls?limit=10").expect(200);
    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.take).toBe(10);
  });

  it("GET /api/calls?limit=999 caps at 200", async () => {
    await request(app.getHttpServer()).get("/api/calls?limit=999").expect(200);
    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.take).toBe(200);
  });

  it("GET /api/calls?limit=0 falls back to the default 50", async () => {
    await request(app.getHttpServer()).get("/api/calls?limit=0").expect(200);
    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.take).toBe(50);
  });

  it("GET /api/calls?limit=garbage falls back to the default 50", async () => {
    await request(app.getHttpServer())
      .get("/api/calls?limit=not-a-number")
      .expect(200);
    const args = prisma.call.findMany.mock.calls[0][0];
    expect(args.take).toBe(50);
  });

  it("GET /api/calls emits BigInt fields as decimal strings", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/calls")
      .expect(200);
    expect(typeof res.body[0].premiumLamports).toBe("string");
    expect(res.body[0].premiumLamports).toBe("500");
    expect(res.body[0].refundLamports).toBe("0");
  });

  it("GET /api/calls/:id returns the call as wire-shaped JSON with recipientShares", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/calls/call-001")
      .expect(200);
    expect(res.body.callId).toBe("call-001");
    expect(res.body.signature).toBe(SIG);
    expect(res.body.premiumLamports).toBe("500");
    expect(res.body.recipientShares).toHaveLength(2);
    expect(res.body.recipientShares[0]).toEqual({
      kind: 0,
      pubkey: "TreasuryPubkey11111111111111111111111111111",
      amountLamports: "50",
    });
    expect(res.body.recipientShares[1]).toEqual({
      kind: 1,
      pubkey: "AffiliateA111111111111111111111111111111111",
      amountLamports: "25",
    });
  });

  it("GET /api/calls/:id returns recipientShares=[] when batch has no shares", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/calls/call-other-batch")
      .expect(200);
    expect(res.body.callId).toBe("call-other-batch");
    expect(res.body.recipientShares).toEqual([]);
  });

  it("GET /api/calls/:id queries shares by Settlement signature, not callId", async () => {
    await request(app.getHttpServer()).get("/api/calls/call-001").expect(200);
    const sharesArg =
      prisma.settlementRecipientShare.findMany.mock.calls[0][0];
    expect(sharesArg.where.settlementSig).toBe(SIG);
  });

  it("GET /api/calls/:id returns 404 for unknown call", async () => {
    await request(app.getHttpServer())
      .get("/api/calls/does-not-exist")
      .expect(404);
  });
});
