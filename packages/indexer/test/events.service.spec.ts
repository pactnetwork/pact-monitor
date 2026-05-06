import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@pact-network/db";
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

interface PrismaMockOptions {
  /** Force `call.create` to throw a generic (non-P2002) error to simulate
   *  a downstream Prisma failure that should roll the transaction back. */
  throwOnCallCreate?: Error;
}

function makePrismaMock(opts: PrismaMockOptions = {}): any {
  const captured: CapturedCall[] = [];
  const callRows = new Map<string, any>();

  const mock: any = {
    captured,
    callRows,
    // EventsService runs everything inside a transaction. Our mock
    // immediately invokes the callback with `tx === self`. If the callback
    // throws, the captured ops are cleared to model rollback semantics.
    $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => {
      const snapshot = captured.length;
      const callsSnapshot = new Map(callRows);
      try {
        return await cb(mock);
      } catch (e) {
        // Rollback: drop everything captured during this txn.
        captured.length = snapshot;
        callRows.clear();
        for (const [k, v] of callsSnapshot.entries()) callRows.set(k, v);
        throw e;
      }
    }),

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
      // findUnique kept for any legacy callers / sanity checks; the service
      // itself now uses `create` + P2002 to detect duplicates.
      findUnique: jest.fn(async (args: any) =>
        callRows.get(args.where.callId) ?? null,
      ),
      create: jest.fn(async (args: any) => {
        if (opts.throwOnCallCreate) throw opts.throwOnCallCreate;
        if (callRows.has(args.data.callId)) {
          // Mirror the Prisma unique-constraint error shape so the service's
          // P2002 catch path is exercised.
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`callId`)",
            { code: "P2002", clientVersion: "test", meta: { target: ["callId"] } },
          );
        }
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

  it("decodes per-call shares from settler payload and stores them", async () => {
    const dto: SettlementEventDto = {
      signature: "sigA",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
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
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "80",
            },
            {
              kind: 1,
              pubkey: "AffiliateAPubkey1111111111111111111111111111",
              amountLamports: "20",
            },
          ],
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
    const byKind = new Map<number, any>(
      createMany!.args.data.map((d: any) => [d.recipientKind, d]),
    );
    expect(byKind.get(0)).toMatchObject({
      settlementSig: "sigA",
      recipientKind: 0,
      amountLamports: 80n,
    });
    expect(byKind.get(1)).toMatchObject({
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
          shares: [],
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
          shares: [],
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
          shares: [],
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
          shares: [],
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
          shares: [],
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

  it("idempotent: ingest() called twice with same callId increments Agent counters exactly once", async () => {
    const dto: SettlementEventDto = {
      signature: "sigDup",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "dup-1",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigDup",
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "100",
            },
          ],
        },
      ],
    };

    // First delivery: should accept the call and run all aggregate updates.
    const r1 = await svc.ingest(dto);
    expect(r1.accepted).toBe(1);

    const agentUpsertsAfterFirst = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent",
    );
    expect(agentUpsertsAfterFirst).toHaveLength(1);

    // Second delivery (same callId): the Call row already exists, so the
    // service must skip Agent / Settlement / SettlementRecipientShare /
    // RecipientEarnings / PoolState entirely.
    const r2 = await svc.ingest(dto);
    expect(r2.accepted).toBe(0);

    const agentUpsertsAfterSecond = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent",
    );
    // Still exactly 1 — no extra agent.upsert from the duplicate.
    expect(agentUpsertsAfterSecond).toHaveLength(1);

    const callCreates = prisma.captured.filter(
      (c: CapturedCall) => c.table === "call" && c.op === "create",
    );
    expect(callCreates).toHaveLength(1);

    // Settlement upsert and SettlementRecipientShare insert should also have
    // happened exactly once across both calls.
    const settlementUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "settlement",
    );
    expect(settlementUpserts).toHaveLength(1);

    const shareCreateMany = prisma.captured.filter(
      (c: CapturedCall) =>
        c.table === "settlementRecipientShare" && c.op === "createMany",
    );
    expect(shareCreateMany).toHaveLength(1);

    const earningsUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "recipientEarnings",
    );
    // One share -> one upsert, NOT two.
    expect(earningsUpserts).toHaveLength(1);

    const poolUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "poolState",
    );
    expect(poolUpserts).toHaveLength(1);
  });

  it("idempotent: aggregate updates roll back if the Call insert fails", async () => {
    const boom = new Error("simulated DB outage");
    const failingPrisma = makePrismaMock({ throwOnCallCreate: boom });
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: failingPrisma },
      ],
    }).compile();
    const failingSvc = mod.get(EventsService);

    const dto: SettlementEventDto = {
      signature: "sigFail",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "fail-1",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigFail",
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "100",
            },
          ],
        },
      ],
    };

    await expect(failingSvc.ingest(dto)).rejects.toThrow("simulated DB outage");

    // Rolled-back transaction: nothing should be persisted.
    const survivors = failingPrisma.captured.filter(
      (c: CapturedCall) =>
        c.table === "agent" ||
        c.table === "call" ||
        c.table === "settlement" ||
        c.table === "settlementRecipientShare" ||
        c.table === "recipientEarnings" ||
        c.table === "poolState",
    );
    expect(survivors).toHaveLength(0);
  });

  it("payload: per-call shares aggregate into batch-level SettlementRecipientShare rows", async () => {
    // Contract with #62 settler: `shares` is per-call on each
    // WrapCallEventDto. The indexer aggregates by (kind, pubkey) across the
    // whole batch into one SettlementRecipientShare row per recipient and
    // one RecipientEarnings upsert per recipient.
    const dto: SettlementEventDto = {
      signature: "sigBatchFees",
      batchSize: 3,
      totalPremiumsLamports: "3000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "bf-1",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigBatchFees",
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "60",
            },
            {
              kind: 1,
              pubkey: "AffiliateAtaPubkey111111111111111111111111111",
              amountLamports: "20",
            },
          ],
        },
        {
          callId: "bf-2",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 110,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigBatchFees",
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "60",
            },
            {
              kind: 1,
              pubkey: "AffiliateAtaPubkey111111111111111111111111111",
              amountLamports: "20",
            },
          ],
        },
        {
          callId: "bf-3",
          agentPubkey: "AgentP22222222222222222222222222222222222222",
          endpointSlug: "birdeye",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 120,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigBatchFees",
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "60",
            },
            {
              kind: 2,
              pubkey: "AffiliatePdaPubkey1111111111111111111111111111",
              amountLamports: "20",
            },
          ],
        },
      ],
    };

    const res = await svc.ingest(dto);
    expect(res.accepted).toBe(3);

    const shareCreate = prisma.captured.find(
      (c: CapturedCall) =>
        c.table === "settlementRecipientShare" && c.op === "createMany",
    );
    expect(shareCreate).toBeDefined();
    // One row per (kind, pubkey): Treasury (0), AffiliateAta (1),
    // AffiliatePda (2) — Treasury sums across all three calls.
    expect(shareCreate!.args.data).toHaveLength(3);
    const byKind = new Map<number, any>(
      shareCreate!.args.data.map((d: any) => [d.recipientKind, d]),
    );
    expect(byKind.get(0)).toMatchObject({
      recipientKind: 0,
      amountLamports: 180n, // 60 + 60 + 60
    });
    expect(byKind.get(1)).toMatchObject({
      recipientKind: 1,
      amountLamports: 40n, // 20 + 20
    });
    expect(byKind.get(2)).toMatchObject({
      recipientKind: 2,
      amountLamports: 20n,
    });
    // Total fees recorded match the sum on the wire.
    const total = shareCreate!.args.data.reduce(
      (s: bigint, d: any) => s + BigInt(d.amountLamports),
      0n,
    );
    expect(total).toBe(240n);

    // One RecipientEarnings upsert per recipient.
    const earningsUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "recipientEarnings",
    );
    expect(earningsUpserts).toHaveLength(3);

    // Pool fees attributed exactly per-endpoint via the per-call shares
    // (no proportional apportioning anymore). helius gets fees from bf-1
    // and bf-2: (60+20) + (60+20) = 160. birdeye gets fees from bf-3:
    // 60+20 = 80. Total still 240.
    const poolUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "poolState",
    );
    const bySlug = new Map<string, any>(
      poolUpserts.map((p: CapturedCall) => [p.args.where.endpointSlug, p]),
    );
    expect(bySlug.get("helius")!.args.create.totalFeesPaidLamports).toBe(160n);
    expect(bySlug.get("birdeye")!.args.create.totalFeesPaidLamports).toBe(80n);
    const poolFeesSum = poolUpserts.reduce(
      (s: bigint, p: CapturedCall) =>
        s + BigInt(p.args.create.totalFeesPaidLamports),
      0n,
    );
    expect(poolFeesSum).toBe(240n);
  });

  it("rejects payloads where any call.shares is missing (must be []), not silently zeroed", async () => {
    // Settler contract drift would otherwise zero out Treasury / affiliate
    // earnings forever. The indexer 400s instead.
    const dto = {
      signature: "sigMissing",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "missing-shares",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigMissing",
          // shares: missing on purpose
        },
      ],
    } as unknown as SettlementEventDto;

    await expect(svc.ingest(dto)).rejects.toBeInstanceOf(BadRequestException);

    // Nothing persisted on rejection.
    const survivors = prisma.captured.filter(
      (c: CapturedCall) => c.table === "call" && c.op === "create",
    );
    expect(survivors).toHaveLength(0);
  });

  it("does NOT create an Agent.walletPda field (agent custody, no PDA)", async () => {
    const dto: SettlementEventDto = {
      signature: "sigD",
      batchSize: 1,
      totalPremiumsLamports: "100",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
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
          shares: [],
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
