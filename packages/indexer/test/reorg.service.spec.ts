/**
 * ReorgService unit tests — WP-MN-04 T3.
 *
 * Uses Jest (indexer's test framework) with manual mocks for PrismaService +
 * AdaptersService. No real DB or RPC is touched.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../src/prisma/prisma.service";
import { AdaptersService } from "../src/adapters/adapters.service";
import { ReorgService } from "../src/reorg/reorg.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedTxOp {
  table: string;
  op: string;
  args: any;
}

interface PrismaMockSeed {
  /** Existing Call rows keyed by `${network}:${callId}`. */
  calls?: Record<
    string,
    {
      network: string;
      callId: string;
      endpointSlug: string;
      signature: string;
      premiumLamports: bigint;
    }
  >;
  /** Existing SettlementRecipientShare rows keyed by `${network}:${settlementSig}`. */
  shares?: Record<
    string,
    Array<{
      network: string;
      settlementSig: string;
      recipientKind: number;
      recipientPubkey: string;
      amountLamports: bigint;
    }>
  >;
  /** Count of Calls per (network, signature) batch, for the multi-call guard. */
  callsInBatch?: Record<string, number>;
}

function makePrismaMock(seed: PrismaMockSeed = {}): any {
  const captured: CapturedTxOp[] = [];
  const calls = { ...(seed.calls ?? {}) };
  const shares = { ...(seed.shares ?? {}) };
  const callsInBatch = { ...(seed.callsInBatch ?? {}) };

  const tx: any = {
    call: {
      findUnique: jest.fn(async (args: any) => {
        const { network, callId } = args.where.network_callId;
        const key = `${network}:${callId}`;
        return calls[key] ?? null;
      }),
      count: jest.fn(async (args: any) => {
        const { network, signature } = args.where;
        const key = `${network}:${signature}`;
        return callsInBatch[key] ?? 0;
      }),
      delete: jest.fn(async (args: any) => {
        captured.push({ table: "call", op: "delete", args });
        const { network, callId } = args.where.network_callId;
        delete calls[`${network}:${callId}`];
        return { network, callId };
      }),
      findMany: jest.fn(async (args: any) => {
        const network = args.where?.network;
        return Object.values(calls)
          .filter((c) => (network ? c.network === network : true))
          .map((c) => ({ callId: c.callId }));
      }),
    },
    poolState: {
      update: jest.fn(async (args: any) => {
        captured.push({ table: "poolState", op: "update", args });
        return null;
      }),
    },
    recipientEarnings: {
      update: jest.fn(async (args: any) => {
        captured.push({ table: "recipientEarnings", op: "update", args });
        return null;
      }),
    },
    settlementRecipientShare: {
      findMany: jest.fn(async (args: any) => {
        const { network, settlementSig } = args.where;
        return shares[`${network}:${settlementSig}`] ?? [];
      }),
      deleteMany: jest.fn(async (args: any) => {
        captured.push({
          table: "settlementRecipientShare",
          op: "deleteMany",
          args,
        });
        const { network, settlementSig } = args.where;
        delete shares[`${network}:${settlementSig}`];
        return { count: 0 };
      }),
    },
    settlement: {
      delete: jest.fn(async (args: any) => {
        captured.push({ table: "settlement", op: "delete", args });
        return null;
      }),
    },
  };

  const mock: any = {
    captured,
    tx,
    // Matches PrismaService.$transaction(cb) — the inner callback receives the
    // tx client. We swallow rollback semantics here (tests assert against
    // ordered captured ops; if the test wants to assert rollback, it should
    // catch the throw at the call site).
    $transaction: jest.fn(async (cb: (txClient: any) => Promise<any>) => {
      return await cb(tx);
    }),
    // Outside-of-transaction access mirror — runReconcile uses
    // prisma.call.findMany() directly (no $transaction wrapper).
    call: tx.call,
  };

  return mock;
}

function makeAdaptersServiceMock(
  network: string,
  yieldedCallIds: string[] | "no-tail" | "no-adapter",
): Partial<AdaptersService> {
  if (yieldedCallIds === "no-adapter") {
    return {
      getAdapter: jest.fn(() => {
        throw new Error(`No adapter for network "${network}"`);
      }),
    };
  }

  const adapter: any = {
    descriptor: { network },
  };
  if (yieldedCallIds !== "no-tail") {
    adapter.tailSettlementEvents = async function* () {
      for (const callId of yieldedCallIds) {
        yield {
          callId,
          settlementSig: `sig-${callId}`,
          blockOrSlot: "100",
        };
      }
    };
  }

  return {
    getAdapter: jest.fn(() => adapter),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReorgService (WP-MN-04 T3)", () => {
  async function buildSvc(opts: {
    prisma: any;
    adapters: Partial<AdaptersService>;
  }): Promise<ReorgService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReorgService,
        { provide: PrismaService, useValue: opts.prisma },
        { provide: AdaptersService, useValue: opts.adapters },
      ],
    }).compile();
    return module.get(ReorgService);
  }

  // -----------------------------------------------------------------------
  // runReconcile
  // -----------------------------------------------------------------------

  describe("runReconcile", () => {
    it("returns correct scanned + orphans counts for an EVM network", async () => {
      const prisma = makePrismaMock({
        calls: {
          "arc-testnet:call-001": {
            network: "arc-testnet",
            callId: "call-001",
            endpointSlug: "helius",
            signature: "sig-001",
            premiumLamports: 1000n,
          },
          "arc-testnet:call-002": {
            network: "arc-testnet",
            callId: "call-002",
            endpointSlug: "helius",
            signature: "sig-002",
            premiumLamports: 1000n,
          },
          "arc-testnet:call-003-orphan": {
            network: "arc-testnet",
            callId: "call-003-orphan",
            endpointSlug: "helius",
            signature: "sig-003",
            premiumLamports: 1000n,
          },
          // Different network — must be ignored by the network filter.
          "solana-devnet:call-solana": {
            network: "solana-devnet",
            callId: "call-solana",
            endpointSlug: "helius",
            signature: "sig-solana",
            premiumLamports: 1000n,
          },
        },
      });
      // Canonical chain returns only 001 and 002 — 003 was orphaned by reorg.
      const adapters = makeAdaptersServiceMock("arc-testnet", [
        "call-001",
        "call-002",
      ]);

      const svc = await buildSvc({ prisma, adapters });
      const result = await svc.runReconcile("arc-testnet", 100n);

      expect(result.network).toBe("arc-testnet");
      expect(result.scanned).toBe(2);
      expect(result.dbCalls).toBe(3); // only arc-testnet rows
      expect(result.orphans).toBe(1);
      expect(result.orphanCallIds).toEqual(["call-003-orphan"]);
      // Tail yielded only 2 events — far below SAFETY_CAP, so the scan ran
      // to completion and the orphans count is trustworthy.
      expect(result.truncated).toBe(false);
    });

    it("throws when the network's adapter does not expose tailSettlementEvents (e.g. SolanaAdapter)", async () => {
      const prisma = makePrismaMock();
      const adapters = makeAdaptersServiceMock("solana-devnet", "no-tail");

      const svc = await buildSvc({ prisma, adapters });
      await expect(svc.runReconcile("solana-devnet", 100n)).rejects.toThrow(
        /does not expose tailSettlementEvents/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // rollback — single-call-per-batch path
  // -----------------------------------------------------------------------

  describe("rollback", () => {
    it("single-call batch: decrements PoolState + RecipientEarnings, deletes shares + Settlement + Call atomically", async () => {
      const prisma = makePrismaMock({
        calls: {
          "arc-testnet:call-orphan": {
            network: "arc-testnet",
            callId: "call-orphan",
            endpointSlug: "helius",
            signature: "sig-batch-A",
            premiumLamports: 500n,
          },
        },
        shares: {
          "arc-testnet:sig-batch-A": [
            {
              network: "arc-testnet",
              settlementSig: "sig-batch-A",
              recipientKind: 0,
              recipientPubkey: "TreasuryPubkey",
              amountLamports: 80n,
            },
            {
              network: "arc-testnet",
              settlementSig: "sig-batch-A",
              recipientKind: 1,
              recipientPubkey: "AffiliatePubkey",
              amountLamports: 20n,
            },
          ],
        },
        callsInBatch: { "arc-testnet:sig-batch-A": 1 },
      });
      const adapters = makeAdaptersServiceMock("arc-testnet", []);

      const svc = await buildSvc({ prisma, adapters });
      await svc.rollback("arc-testnet", "call-orphan");

      // PoolState decrement by premiumLamports.
      const poolOps = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "poolState",
      );
      expect(poolOps).toHaveLength(1);
      expect(poolOps[0]!.args).toEqual({
        where: {
          network_endpointSlug: {
            network: "arc-testnet",
            endpointSlug: "helius",
          },
        },
        data: { currentBalanceLamports: { decrement: 500n } },
      });

      // RecipientEarnings decremented for both shares.
      const earningsOps = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "recipientEarnings",
      );
      expect(earningsOps).toHaveLength(2);
      const earningsByPubkey = new Map(
        earningsOps.map((o: CapturedTxOp) => [
          o.args.where.network_recipientPubkey.recipientPubkey,
          o.args.data.lifetimeEarnedLamports.decrement,
        ]),
      );
      expect(earningsByPubkey.get("TreasuryPubkey")).toBe(80n);
      expect(earningsByPubkey.get("AffiliatePubkey")).toBe(20n);

      // SettlementRecipientShare deleteMany by (network, settlementSig).
      const shareDeletes = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "settlementRecipientShare",
      );
      expect(shareDeletes).toHaveLength(1);
      expect(shareDeletes[0]!.args.where).toEqual({
        network: "arc-testnet",
        settlementSig: "sig-batch-A",
      });

      // Settlement.delete via network_signature composite.
      const settlementDeletes = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "settlement",
      );
      expect(settlementDeletes).toHaveLength(1);
      expect(settlementDeletes[0]!.args.where).toEqual({
        network_signature: {
          network: "arc-testnet",
          signature: "sig-batch-A",
        },
      });

      // Call.delete via network_callId composite.
      const callDeletes = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "call" && c.op === "delete",
      );
      expect(callDeletes).toHaveLength(1);
      expect(callDeletes[0]!.args.where).toEqual({
        network_callId: { network: "arc-testnet", callId: "call-orphan" },
      });
    });

    it("throws when the Call row does not exist", async () => {
      const prisma = makePrismaMock();
      const adapters = makeAdaptersServiceMock("arc-testnet", []);

      const svc = await buildSvc({ prisma, adapters });
      await expect(
        svc.rollback("arc-testnet", "missing-call"),
      ).rejects.toThrow(
        /no Call row for network=arc-testnet callId=missing-call/,
      );

      // Nothing else was touched.
      const touched = prisma.captured.filter(
        (c: CapturedTxOp) =>
          c.table === "poolState" ||
          c.table === "settlement" ||
          c.table === "settlementRecipientShare" ||
          (c.table === "call" && c.op === "delete"),
      );
      expect(touched).toHaveLength(0);
    });

    it("multi-call batch: skips Settlement + shares deletes and earnings rollback, deletes only the Call row", async () => {
      // Two calls share batch sig-batch-multi. We're only rolling back one of
      // them, so the Settlement + shares + cross-call earnings attribution
      // must stay intact.
      const prisma = makePrismaMock({
        calls: {
          "arc-testnet:call-x": {
            network: "arc-testnet",
            callId: "call-x",
            endpointSlug: "helius",
            signature: "sig-batch-multi",
            premiumLamports: 500n,
          },
          "arc-testnet:call-y": {
            network: "arc-testnet",
            callId: "call-y",
            endpointSlug: "helius",
            signature: "sig-batch-multi",
            premiumLamports: 500n,
          },
        },
        shares: {
          "arc-testnet:sig-batch-multi": [
            {
              network: "arc-testnet",
              settlementSig: "sig-batch-multi",
              recipientKind: 0,
              recipientPubkey: "TreasuryPubkey",
              amountLamports: 160n,
            },
          ],
        },
        callsInBatch: { "arc-testnet:sig-batch-multi": 2 },
      });
      const adapters = makeAdaptersServiceMock("arc-testnet", []);

      const svc = await buildSvc({ prisma, adapters });
      await svc.rollback("arc-testnet", "call-x");

      // PoolState still decremented (per-call premium debit is independent
      // of the batch-level shares attribution).
      const poolOps = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "poolState",
      );
      expect(poolOps).toHaveLength(1);
      expect(poolOps[0]!.args.data.currentBalanceLamports.decrement).toBe(500n);

      // RecipientEarnings NOT touched — shares are batch-level summed across
      // calls; we cannot attribute cleanly to one call so we leave them.
      const earningsOps = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "recipientEarnings",
      );
      expect(earningsOps).toHaveLength(0);

      // Settlement + shares NOT deleted — other calls in the batch still
      // reference them via FK.
      const shareDeletes = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "settlementRecipientShare",
      );
      expect(shareDeletes).toHaveLength(0);

      const settlementDeletes = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "settlement",
      );
      expect(settlementDeletes).toHaveLength(0);

      // Only the target Call row is deleted.
      const callDeletes = prisma.captured.filter(
        (c: CapturedTxOp) => c.table === "call" && c.op === "delete",
      );
      expect(callDeletes).toHaveLength(1);
      expect(callDeletes[0]!.args.where.network_callId.callId).toBe("call-x");
    });
  });
});
