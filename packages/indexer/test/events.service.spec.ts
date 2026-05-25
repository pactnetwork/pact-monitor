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
  // Fake Postgres store for SettlementRecipientShare rows so the
  // network-scoped idempotency check (review #226 F3) is observable: a
  // same-signature batch on a different network must NOT find the first
  // network's rows.
  const recipientShareRows: any[] = [];

  const mock: any = {
    captured,
    callRows,
    recipientShareRows,
    // EventsService runs everything inside a transaction. Our mock
    // immediately invokes the callback with `tx === self`. If the callback
    // throws, the captured ops are cleared to model rollback semantics.
    $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => {
      const snapshot = captured.length;
      const callsSnapshot = new Map(callRows);
      const shareRowsSnapshot = recipientShareRows.length;
      try {
        return await cb(mock);
      } catch (e) {
        // Rollback: drop everything captured during this txn.
        captured.length = snapshot;
        callRows.clear();
        for (const [k, v] of callsSnapshot.entries()) callRows.set(k, v);
        recipientShareRows.length = shareRowsSnapshot;
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
      // count honors the `where` filter against stored rows so network-scoped
      // idempotency (F3) is observable. A stored row matches when EVERY field
      // in `where` equals the row's value — so a sig-only filter matches
      // across networks (the bug), while a (network, sig) filter does not.
      count: jest.fn(async (args: any) => {
        captured.push({
          table: "settlementRecipientShare",
          op: "count",
          args,
        });
        const where = args.where ?? {};
        return recipientShareRows.filter((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        ).length;
      }),
      createMany: jest.fn(async (args: any) => {
        captured.push({
          table: "settlementRecipientShare",
          op: "createMany",
          args,
        });
        for (const row of args.data) recipientShareRows.push(row);
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
      update: jest.fn(async (args: any) => {
        captured.push({ table: "agent", op: "update", args });
        return null;
      }),
    },
    call: {
      // findUnique kept for any legacy callers / sanity checks; the service
      // itself now uses `create` + P2002 to detect duplicates.
      // Key is composite `network:callId` to match @@id([network, callId]).
      findUnique: jest.fn(async (args: any) => {
        const nk = args.where.network_callId;
        const key = nk
          ? `${nk.network}:${nk.callId}`
          : `solana-devnet:${args.where.callId}`;
        return callRows.get(key) ?? null;
      }),
      create: jest.fn(async (args: any) => {
        if (opts.throwOnCallCreate) throw opts.throwOnCallCreate;
        // Composite dedup key matches the real @@id([network, callId]) PK.
        const network = args.data.network ?? "solana-devnet";
        const compositeKey = `${network}:${args.data.callId}`;
        if (callRows.has(compositeKey)) {
          // Mirror the Prisma unique-constraint error shape so the service's
          // P2002 catch path is exercised.
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`network`, `callId`)",
            { code: "P2002", clientVersion: "test", meta: { target: ["network", "callId"] } },
          );
        }
        captured.push({ table: "call", op: "create", args });
        callRows.set(compositeKey, args.data);
        return args.data;
      }),
    },
    endpoint: {
      findUnique: jest.fn(async (args: any) => {
        const slug = args.where.network_slug?.slug ?? args.where.slug;
        return { slug };
      }),
      upsert: jest.fn(async (args: any) => {
        captured.push({ table: "endpoint", op: "upsert", args });
        const slug = args.where.network_slug?.slug ?? args.where.slug;
        return { slug };
      }),
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
    // B8: network_error is a covered SLA breach. Wrap classifier sets
    // premium=flat + refund=imputed and the on-chain program debits the
    // pool, so the indexer must record breach=true to keep PoolState in
    // sync with CoveragePool.current_balance.
    expect(outcomeToBreach("network_error")).toEqual({
      breach: true,
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
      .map((u: CapturedCall) => u.args.where.network_endpointSlug.endpointSlug)
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
    // B8 audit: client_error stays breach=false. The wrap classifier sets
    // premium=0 for client_error and the settler drops it at the batcher
    // before it ever reaches the indexer; if a misclassified one slips
    // through with a non-zero premium we still record breach=false honestly.
    expect(byId.get("c-client-err")).toMatchObject({
      breach: false,
      breachReason: "client_error",
    });
  });

  it("B8: network_error is recorded as breach=true and refund flows into PoolState", async () => {
    // The wrap classifier (packages/wrap/src/classifier.ts:58) maps
    // network_error → premium=flat, refund=imputed. The settler's
    // breachFromOutcome (packages/settler/src/submitter/submitter.service.ts:506)
    // returns true. The on-chain program debits the pool. The indexer must
    // record breach=true on the Call row AND increment PoolState refund
    // totals so it reconciles with CoveragePool.current_balance.
    const dto: SettlementEventDto = {
      signature: "sigB8",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "5000",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "b8-net-err",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "5000",
          latencyMs: 0,
          outcome: "network_error",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigB8",
          shares: [],
        },
      ],
    };

    const res = await svc.ingest(dto);
    expect(res.accepted).toBe(1);

    // Call row: breach=true, breachReason="network_error".
    const callCreate = prisma.captured.find(
      (c: CapturedCall) => c.table === "call" && c.op === "create",
    );
    expect(callCreate).toBeDefined();
    expect(callCreate!.args.data).toMatchObject({
      callId: "b8-net-err",
      breach: true,
      breachReason: "network_error",
      refundLamports: 5000n,
    });

    // PoolState: refund total is incremented by the on-wire refund amount
    // (the field flow is independent of breach=true; the bug was that the
    // Call.breach flag previously disagreed with on-chain pool debits).
    const poolUpsert = prisma.captured.find(
      (c: CapturedCall) => c.table === "poolState",
    );
    expect(poolUpsert).toBeDefined();
    expect(poolUpsert!.args.create.totalRefundsLamports).toBe(5000n);
    expect(poolUpsert!.args.update.totalRefundsLamports).toEqual({
      increment: 5000n,
    });

    // Agent counters reflect the refund as well.
    const agentUpdate = prisma.captured.find(
      (c: CapturedCall) => c.table === "agent" && c.op === "update",
    );
    expect(agentUpdate).toBeDefined();
    expect(agentUpdate!.args.data.totalRefundsLamports).toEqual({
      increment: 5000n,
    });
  });

  it("B8 audit: client_error keeps breach=false (premium=0, batcher drops upstream)", async () => {
    // The settler's batcher drops zero-premium events before pushing to the
    // indexer (B2). This test guards the indexer's behavior in case a
    // misclassified event with non-zero premium ever leaks through: the row
    // must still record breach=false, breachReason="client_error" so the
    // mismatch is visible in analytics rather than silently treated as a
    // covered breach.
    const dto: SettlementEventDto = {
      signature: "sigClientB8",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "b8-client-err",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 50,
          outcome: "client_error",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigClientB8",
          shares: [],
        },
      ],
    };

    await svc.ingest(dto);

    const callCreate = prisma.captured.find(
      (c: CapturedCall) => c.table === "call" && c.op === "create",
    );
    expect(callCreate).toBeDefined();
    expect(callCreate!.args.data).toMatchObject({
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

    // FK-prep upsert (B11) + counter-bump update — both run on first delivery.
    const agentOpsAfterFirst = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent",
    );
    expect(agentOpsAfterFirst).toHaveLength(2);
    expect(
      agentOpsAfterFirst.filter((c: CapturedCall) => c.op === "upsert"),
    ).toHaveLength(1);
    expect(
      agentOpsAfterFirst.filter((c: CapturedCall) => c.op === "update"),
    ).toHaveLength(1);

    // Second delivery (same callId): the Call row already exists, so the
    // service must skip Agent counter bumps / Settlement / SettlementRecipientShare /
    // RecipientEarnings / PoolState entirely. The FK-prep Agent.upsert still
    // fires (it's a no-op `update: {}` upsert) — that's intentional, it
    // guarantees the FK target exists before Call.create regardless of
    // whether the call ends up being a duplicate.
    const r2 = await svc.ingest(dto);
    expect(r2.accepted).toBe(0);

    const agentOpsAfterSecond = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent",
    );
    // FK-prep upsert fires again (no-op), but NO counter-bump update.
    expect(
      agentOpsAfterSecond.filter((c: CapturedCall) => c.op === "update"),
    ).toHaveLength(1); // still just the one from the first delivery
    expect(
      agentOpsAfterSecond.filter((c: CapturedCall) => c.op === "upsert"),
    ).toHaveLength(2); // one per delivery, both no-op `update: {}`

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
      poolUpserts.map((p: CapturedCall) => [p.args.where.network_endpointSlug.endpointSlug, p]),
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

  it("B11: brand-new agent + endpoint are upserted BEFORE Call.create (no FK 500)", async () => {
    // Regression for B11. On a green DB, the very first call from a
    // brand-new agent / endpoint used to 500 with Call_agentPubkey_fkey
    // because tryInsertCall ran before any Agent / Endpoint upsert. The
    // fix is to upsert FK targets first inside the same tx.
    const dto: SettlementEventDto = {
      signature: "sigB11",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "b11-1",
          agentPubkey: "BrandNewAgent111111111111111111111111111111",
          endpointSlug: "brand-new-ep",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigB11",
          shares: [],
        },
      ],
    };

    const res = await svc.ingest(dto);
    expect(res.accepted).toBe(1);

    // Critical ordering: agent.upsert + endpoint.upsert must both come
    // BEFORE call.create. If the order regresses, B11 is back.
    const ops = prisma.captured.map((c: CapturedCall) => `${c.table}.${c.op}`);
    const agentUpsertIdx = ops.indexOf("agent.upsert");
    const endpointUpsertIdx = ops.indexOf("endpoint.upsert");
    const callCreateIdx = ops.indexOf("call.create");
    expect(agentUpsertIdx).toBeGreaterThanOrEqual(0);
    expect(endpointUpsertIdx).toBeGreaterThanOrEqual(0);
    expect(callCreateIdx).toBeGreaterThanOrEqual(0);
    expect(agentUpsertIdx).toBeLessThan(callCreateIdx);
    expect(endpointUpsertIdx).toBeLessThan(callCreateIdx);

    // Endpoint lazy-create uses safe placeholder defaults (paused=true,
    // zeroed business fields) — admin overwrites these via on-chain
    // registration ingestion before the endpoint participates in real
    // rate computation.
    const epUpsert = prisma.captured.find(
      (c: CapturedCall) => c.table === "endpoint" && c.op === "upsert",
    );
    expect(epUpsert).toBeDefined();
    expect(epUpsert!.args.create).toMatchObject({
      slug: "brand-new-ep",
      paused: true,
      flatPremiumLamports: 0n,
      percentBps: 0,
    });
    // Re-delivery / pre-existing endpoint must not stomp business fields:
    // update branch is a no-op.
    expect(epUpsert!.args.update).toEqual({});
  });

  it("B12: dedupes + lex-sorts FK upserts so concurrent batches lock in same order", async () => {
    // Regression for B12. With three calls sharing two agents and two
    // endpoints in mixed order, the service must:
    //   - Issue exactly one Agent.upsert per distinct pubkey (deduped).
    //   - Issue exactly one Endpoint.upsert per distinct slug (deduped).
    //   - Issue them in lexicographically sorted order — this is what
    //     guarantees concurrent transactions take row-locks in the same
    //     order and never deadlock.
    const dto: SettlementEventDto = {
      signature: "sigB12",
      batchSize: 3,
      totalPremiumsLamports: "3000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "b12-1",
          agentPubkey: "Zeta1111111111111111111111111111111111111111",
          endpointSlug: "z-ep",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigB12",
          shares: [],
        },
        {
          callId: "b12-2",
          agentPubkey: "Alpha111111111111111111111111111111111111111",
          endpointSlug: "a-ep",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigB12",
          shares: [],
        },
        {
          callId: "b12-3",
          // Same agent + endpoint as call #1 — must be deduped.
          agentPubkey: "Zeta1111111111111111111111111111111111111111",
          endpointSlug: "z-ep",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigB12",
          shares: [],
        },
      ],
    };

    await svc.ingest(dto);

    const agentUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent" && c.op === "upsert",
    );
    expect(agentUpserts).toHaveLength(2); // deduped
    const agentOrder = agentUpserts.map((u: CapturedCall) => u.args.where.pubkey);
    expect(agentOrder).toEqual([...agentOrder].sort()); // lex-sorted

    const endpointUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "endpoint" && c.op === "upsert",
    );
    expect(endpointUpserts).toHaveLength(2); // deduped
    const endpointOrder = endpointUpserts.map(
      (u: CapturedCall) => u.args.where.network_slug.slug,
    );
    expect(endpointOrder).toEqual([...endpointOrder].sort()); // lex-sorted

    // Counter-bump updates and pool upserts must use the SAME lex order so
    // concurrent batches lock those rows in the same order too.
    const agentUpdates = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent" && c.op === "update",
    );
    const updateOrder = agentUpdates.map(
      (u: CapturedCall) => u.args.where.pubkey,
    );
    expect(updateOrder).toEqual([...updateOrder].sort());

    const poolUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "poolState",
    );
    const poolOrder = poolUpserts.map(
      (u: CapturedCall) => u.args.where.network_endpointSlug.endpointSlug,
    );
    expect(poolOrder).toEqual([...poolOrder].sort());
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

  // Finding 5b — the batch network (dto.network) must stamp every aggregate
  // row (Settlement, Endpoint-FK, PoolState, recipient shares + earnings) and
  // the per-call network must stamp the Call row, instead of defaulting to
  // solana-devnet.
  it("finding 5: an arc-testnet batch stamps every aggregate + call row under arc-testnet", async () => {
    const dto: SettlementEventDto = {
      signature: "sigArc",
      network: "arc-testnet",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "arc-c1",
          network: "arc-testnet",
          agentPubkey: "0xAgent000000000000000000000000000000000001",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigArc",
          shares: [
            {
              kind: 0,
              pubkey: "0xTreasury0000000000000000000000000000000001",
              amountLamports: "100",
            },
          ],
        },
      ],
    };

    const res = await svc.ingest(dto);
    expect(res.accepted).toBe(1);
    assertAllRowsUnderNetwork(prisma, "arc-testnet");
  });

  // Regression: an unstamped batch (no dto.network, no call.network) must keep
  // landing every row under solana-devnet.
  it("regression: an unstamped batch lands every aggregate + call row under solana-devnet", async () => {
    const dto: SettlementEventDto = {
      signature: "sigSol",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "sol-c1",
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigSol",
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

    const res = await svc.ingest(dto);
    expect(res.accepted).toBe(1);
    assertAllRowsUnderNetwork(prisma, "solana-devnet");
  });

  // Finding F2 (review #226) — dto.network and per-call call.network must not
  // diverge. The batch resolves ONE network = dto.network ?? calls[0].network
  // ?? solana-devnet; any call that explicitly resolves to a DIFFERENT network
  // is a malformed/replayed payload that would split a single settlement's
  // accounting across two networks. It must 400 with zero rows written.
  it("F2: a call whose network diverges from dto.network is rejected 400 with no rows", async () => {
    const dto = {
      signature: "sigDiverge",
      network: "solana-devnet",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "diverge-1",
          network: "arc-testnet", // diverges from dto.network
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigDiverge",
          shares: [],
        },
      ],
    } as SettlementEventDto;

    await expect(svc.ingest(dto)).rejects.toBeInstanceOf(BadRequestException);

    // Rejection happens before the transaction opens — NO rows of any kind.
    expect(prisma.captured).toHaveLength(0);
  });

  // Finding F2 consistency: dto.network set, call.network omitted. The call
  // must INHERIT the resolved batch network so the Call row lands under the
  // same network as the aggregates. Previously the Call row defaulted to
  // solana-devnet while aggregates landed under dto.network (the "vice versa"
  // split in the finding).
  it("F2: a call with no explicit network inherits the resolved batch network for every row", async () => {
    const dto: SettlementEventDto = {
      signature: "sigInherit",
      network: "arc-testnet",
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: "inherit-1",
          // network omitted on purpose -> must inherit arc-testnet
          agentPubkey: "0xAgent000000000000000000000000000000000001",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigInherit",
          shares: [
            {
              kind: 0,
              pubkey: "0xTreasury0000000000000000000000000000000001",
              amountLamports: "100",
            },
          ],
        },
      ],
    };

    const res = await svc.ingest(dto);
    expect(res.accepted).toBe(1);
    assertAllRowsUnderNetwork(prisma, "arc-testnet");
  });

  // Finding F3 (review #226) — SettlementRecipientShare idempotency must be
  // scoped by (network, settlementSig), not signature alone. The same tx/hash
  // string can legitimately appear on two networks; each must create its OWN
  // recipient-share + earnings rows instead of the second network's rows being
  // skipped because the first network already used that signature.
  it("F3: same signature on two networks creates recipient shares + earnings for BOTH networks", async () => {
    const makeDto = (network: string, callId: string): SettlementEventDto => ({
      signature: "sigSharedAcrossNets",
      network,
      batchSize: 1,
      totalPremiumsLamports: "1000",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId,
          network,
          agentPubkey: "AgentP11111111111111111111111111111111111111",
          endpointSlug: "helius",
          premiumLamports: "1000",
          refundLamports: "0",
          latencyMs: 100,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: "sigSharedAcrossNets",
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "100",
            },
          ],
        },
      ],
    });

    const r1 = await svc.ingest(makeDto("solana-devnet", "shared-sol"));
    expect(r1.accepted).toBe(1);
    const r2 = await svc.ingest(makeDto("arc-testnet", "shared-arc"));
    expect(r2.accepted).toBe(1);

    // Each network created its OWN SettlementRecipientShare batch.
    const shareNetworks = prisma.captured
      .filter(
        (c: CapturedCall) =>
          c.table === "settlementRecipientShare" && c.op === "createMany",
      )
      .flatMap((c: CapturedCall) => c.args.data.map((d: any) => d.network))
      .sort();
    expect(shareNetworks).toEqual(["arc-testnet", "solana-devnet"]);

    // Each network created its OWN RecipientEarnings row.
    const earningsNetworks = prisma.captured
      .filter((c: CapturedCall) => c.table === "recipientEarnings")
      .map((c: CapturedCall) => c.args.create.network)
      .sort();
    expect(earningsNetworks).toEqual(["arc-testnet", "solana-devnet"]);
  });
});

/**
 * Assert that every persisted aggregate row (Settlement, Endpoint, PoolState,
 * SettlementRecipientShare, RecipientEarnings) and the Call row carry the
 * expected network, and that NONE landed under any other network.
 */
function assertAllRowsUnderNetwork(
  prisma: ReturnType<typeof makePrismaMock>,
  expected: string,
): void {
  const networks: string[] = [];
  for (const c of prisma.captured as CapturedCall[]) {
    if (c.table === "agent") continue; // Agent rows are not network-keyed
    if (c.op === "createMany") {
      for (const row of c.args.data) networks.push(row.network);
    } else if (c.table === "call") {
      networks.push(c.args.data.network);
    } else if (c.args.create?.network !== undefined) {
      networks.push(c.args.create.network);
    }
  }
  expect(networks.length).toBeGreaterThan(0);
  for (const n of networks) expect(n).toBe(expected);
}

// ---------------------------------------------------------------------------
// WP-MN-04 T3: EVM reorg-replay dedup regression
// ---------------------------------------------------------------------------
// D6 §4 mandates that a reorg-replay delivering the same (network, callId)
// with a DIFFERENT on-chain signature is idempotent. This test locks the
// existing behavior (@@id([network, callId]) + P2002 in tryInsertCall) so
// that a future refactor cannot silently break EVM reorg safety.
//
// The test is a REGRESSION LOCK, not a behavior change. If it fails it means
// the dedup path in tryInsertCall or the composite PK has been broken.
// ---------------------------------------------------------------------------

describe("EventsService.ingest — (network, callId) dedup regression for EVM reorg-replay (WP-MN-04 T3)", () => {
  let svc: EventsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const mod = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = mod.get(EventsService);
  });

  it("same (network, callId) with different signature is idempotent — EVM reorg-replay (Call PK dedup)", async () => {
    // Simulate an EVM reorg: the settler delivers the same callId on
    // arc-testnet but from a different block/signature (the original block
    // was re-orged and re-mined). The second delivery must be a no-op: the
    // Call row from the first delivery survives, no second row is created,
    // and aggregate counters are NOT double-counted.

    const NETWORK = "arc-testnet";
    const CALL_ID = "evm-reorg-call-0000-0000-000000000001";
    const AGENT = "AgentP11111111111111111111111111111111111111";

    const makeDto = (sig: string): SettlementEventDto => ({
      signature: sig,
      batchSize: 1,
      totalPremiumsLamports: "500",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [
        {
          callId: CALL_ID,
          network: NETWORK,
          agentPubkey: AGENT,
          endpointSlug: "helius",
          premiumLamports: "500",
          refundLamports: "0",
          latencyMs: 120,
          outcome: "ok",
          ts: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          signature: sig,
          shares: [
            {
              kind: 0,
              pubkey: "TreasuryPubkey11111111111111111111111111111",
              amountLamports: "50",
            },
          ],
        },
      ],
    });

    // First delivery: original block, signature A.
    const r1 = await svc.ingest(makeDto("sigReorgOriginal"));
    expect(r1.accepted).toBe(1);

    // Capture state after first delivery.
    const callCreatesAfterFirst = prisma.captured.filter(
      (c: CapturedCall) => c.table === "call" && c.op === "create",
    );
    expect(callCreatesAfterFirst).toHaveLength(1);
    // The surviving row has the FIRST signature.
    expect(callCreatesAfterFirst[0]!.args.data.signature).toBe("sigReorgOriginal");

    const agentUpdatesAfterFirst = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent" && c.op === "update",
    );
    expect(agentUpdatesAfterFirst).toHaveLength(1);

    // Second delivery: reorg produced a new block with different signature
    // but the same callId on the same network. Must be a complete no-op.
    const r2 = await svc.ingest(makeDto("sigReorgReplacement"));
    expect(r2.accepted).toBe(0);

    // Exactly ONE call.create across both deliveries — the second P2002s.
    const callCreatesTotal = prisma.captured.filter(
      (c: CapturedCall) => c.table === "call" && c.op === "create",
    );
    expect(callCreatesTotal).toHaveLength(1);

    // Agent counters incremented exactly once (no double-count).
    const agentUpdatesTotal = prisma.captured.filter(
      (c: CapturedCall) => c.table === "agent" && c.op === "update",
    );
    expect(agentUpdatesTotal).toHaveLength(1);

    // PoolState upserted exactly once.
    const poolUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "poolState",
    );
    expect(poolUpserts).toHaveLength(1);

    // Settlement + SettlementRecipientShare inserted exactly once.
    const settlementUpserts = prisma.captured.filter(
      (c: CapturedCall) => c.table === "settlement",
    );
    expect(settlementUpserts).toHaveLength(1);

    const shareInserts = prisma.captured.filter(
      (c: CapturedCall) =>
        c.table === "settlementRecipientShare" && c.op === "createMany",
    );
    expect(shareInserts).toHaveLength(1);

    // The surviving Call row has the first (pre-reorg) signature, not the
    // replacement. The P2002 short-circuits — the second insert is skipped
    // entirely, preserving the original row.
    expect(callCreatesTotal[0]!.args.data.network).toBe(NETWORK);
    expect(callCreatesTotal[0]!.args.data.callId).toBe(CALL_ID);
  });
});
