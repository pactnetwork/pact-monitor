import { Test, TestingModule } from "@nestjs/testing";
import { EventsService } from "../src/events/events.service";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  outcomeToBreach,
  SettlementEventDto,
} from "../src/events/events.dto";

// Lightweight in-memory mock that captures upserts/creates so we can
// assert against them. We are not exercising real Prisma SQL here; we
// just want to be sure the projection logic + per-endpoint distribution
// in EventsService is correct.

interface CapturedCall {
  table: string;
  op: string;
  args: any;
}

function makePrismaMock(): any {
  const captured: CapturedCall[] = [];
  const callRows = new Map<string, any>();

  const mock: any = {
    captured,
    callRows,
    // EventsService runs everything inside a transaction. Our mock
    // immediately invokes the callback with `tx === self`.
    $transaction: jest.fn(async (cb: (tx: any) => Promise<void>) => cb(mock)),

    settlement: {
      upsert: jest.fn(async (args: any) => {
        captured.push({ table: "settlement", op: "upsert", args });
        return null;
      }),
    },
    settlementRecipientShare: {
      count: jest.fn(async (args: any) => {
        captured.push({
          table: "settlementRecipientShare",
          op: "count",
          args,
        });
        return 0; // pretend we have not stored shares yet
      }),
      createMany: jest.fn(async (args: any) => {
        captured.push({
          table: "settlementRecipientShare",
          op: "createMany",
          args,
        });
        return { count: args.data.length };
      }),
    },
    recipientEarnings: {
      upsert: jest.fn(async (args: any) => {
        captured.push({ table: "recipientEarnings", op: "upsert", args });
        return null;
      }),
    },
    agent: {
      upsert: jest.fn(async (args: any) => {
        captured.push({ table: "agent", op: "upsert", args });
        return null;
      }),
    },
    call: {
      findUnique: jest.fn(async (args: any) =>
        callRows.get(args.where.callId) ?? null,
      ),
      create: jest.fn(async (args: any) => {
        captured.push({ table: "call", op: "create", args });
        callRows.set(args.data.callId, args.data);
        return args.data;
      }),
    },
    endpoint: {
      findUnique: jest.fn(async (args: any) => ({ slug: args.where.slug })),
    },
    poolState: {
      upsert: jest.fn(async (args: any) => {
        captured.push({ table: "poolState", op: "upsert", args });
        return null;
      }),
    },
  };
  return mock;
}

describe("outcomeToBreach", () => {
  it("maps every Outcome to the correct breach/breachReason", () => {
    expect(outcomeToBreach("ok")).toEqual({ breach: false, breachReason: null });
    expect(outcomeToBreach("latency_breach")).toEqual({
      breach: true,
      breachReason: "latency_breach",
    });
    expect(outcomeToBreach("server_error")).toEqual({
      breach: true,
      breachReason: "server_error",
    });
    expect(outcomeToBreach("client_error")).toEqual({
      breach: false,
      breachReason: "client_error",
    });
    expect(outcomeToBreach("network_error")).toEqual({
      breach: false,
      breachReason: "network_error",
    });
  });
});

describe("EventsService", () => {
  let svc: EventsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = mod.get(EventsService);
  });

  it("decodes per-recipient shares from settler payload and stores them", async () => {
    const dto: SettlementEventDto = {
      signature: "sigA",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      shares: [
        {
          recipientKind: 0,
          recipientPubkey: "TreasuryPubkey11111111111111111111111111111",
          amountLamports: "80",
        },
        {
          recipientKind: 1,
          recipientPubkey: "AffiliateAPubkey1111111111111111111111111111",
          amountLamports: "20",
        },
      ],
      calls: [
        {
          callId: "c1",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigA",
        },
      ],
    };

    const res = await svc.ingest(dto);
    expect(res.accepted).toBe(1);

    const createMany = prisma.captured.find(
      (c: CapturedCall) =>
        c.table === "settlementRecipientShare" && c.op === "createMany",
    );
    expect(createMany).toBeDefined();
    expect(createMany!.args.data).toHaveLength(2);
    expect(createMany!.args.data[0]).toMatchObject({
      settlementSig: "sigA",
      recipientKind: 0,
      amountLamports: 80n,
    });
    expect(createMany!.args.data[1]).toMatchObject({
      recipientKind: 1,
      amountLamports: 20n,
    });

    const earningsUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "recipientEarnings",
    );
    expect(earningsUpserts).toHaveLength(2);
  });

  it("upserts PoolState per endpoint slug (not a singleton)", async () => {
    const dto: SettlementEventDto = {
      signature: "sigB",
      batchSize: 2,
      totalPremiumsLamports: "1500",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      shares: [],
      calls: [
        {
          callId: "c2",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigB",
        },
        {
          callId: "c3",
          agentPubkey: "AgentP22222222222222222222222222222222222222",
          endpointSlug: "birdeye",
          premiumLamports: "500",
          refundLamports: "0",
          latencyMs: 90,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigB",
        },
      ],
    };

    await svc.ingest(dto);

    const poolUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "poolState",
    );
    expect(poolUpserts).toHaveLength(2);
    const slugs = poolUpserts
      .map((u: CapturedCall) => u.args.where.endpointSlug)
      .sort();
    expect(slugs).toEqual(["birdeye", "helius"]);
  });

  it("translates breach outcomes into Call.breach=true with breachReason", async () => {
    const dto: SettlementEventDto = {
      signature: "sigC",
      batchSize: 2,
      totalPremiumsLamports: "0",
      totalRefundsLamports: "2000",
      ts: new Date().toISOString(),
      shares: [],
      calls: [
        {
          callId: "c-breach",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "0",
          refundLamports: "1000",
          latencyMs: 5000,
          outcome: "latency_breach",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigC",
        },
        {
          callId: "c-server-err",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "0",
          refundLamports: "1000",
          latencyMs: 200,
          outcome: "server_error",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigC",
        },
        {
          callId: "c-client-err",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "0",
          refundLamports: "0",
          latencyMs: 80,
          outcome: "client_error",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigC",
        },
      ],
    };

    await svc.ingest(dto);

    const calls = prisma.captured.filter(
      (c: CapturedCall) => c.table === "call" && c.op === "create",
    );
    const byId = new Map<string, any>(
      calls.map((c: CapturedCall) => [c.args.data.callId, c.args.data]),
    );
    expect(byId.get("c-breach")).toMatchObject({
      breach: true,
      breachReason: "latency_breach",
    });
    expect(byId.get("c-server-err")).toMatchObject({
      breach: true,
      breachReason: "server_error",
    });
    expect(byId.get("c-client-err")).toMatchObject({
      breach: false,
      breachReason: "client_error",
    });
  });

  it("does NOT create an Agent.walletPda field (agent custody, no PDA)", async () => {
    const dto: SettlementEventDto = {
      signature: "sigD",
      batchSize: 1,
      totalPremiumsLamports: "100",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      shares: [],
      calls: [
        {
          callId: "cD",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "100",
          refundLamports: "0",
          latencyMs: 90,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigD",
        },
      ],
    };

    await svc.ingest(dto);

    const agentUpsert = prisma.captured.find(
      (c: CapturedCall) => c.table === "agent",
    );
    expect(agentUpsert).toBeDefined();
    expect(agentUpsert!.args.create.walletPda).toBeUndefined();
    expect(agentUpsert!.args.update.walletPda).toBeUndefined();
  });
});
