/**
 * ReorgService — D6 §5.2 reorg-rollback module (WP-MN-04 T3).
 *
 * Two responsibilities:
 *
 *   1. `runReconcile(network, fromBlock)` — detection only. Tail finalized
 *      CallSettled events from the canonical chain via
 *      `ChainAdapter.tailSettlementEvents` and report any DB Call rows whose
 *      callId is NOT present in the canonical-chain window. No automatic
 *      deletion per D6 §5.2 (the policy is operator-driven).
 *
 *   2. `rollback(network, callId)` — operator-driven hard-reorg rollback.
 *      Atomic transaction that:
 *        - decrements PoolState.currentBalanceLamports by call.premiumLamports
 *          (ALWAYS — premium debit is the per-call piece);
 *        - IF callsInBatch === 1 (this is the only Call in the batch):
 *            * decrements each RecipientEarnings.lifetimeEarnedLamports by
 *              the matching SettlementRecipientShare.amountLamports;
 *            * deletes SettlementRecipientShare rows for the batch;
 *            * deletes the Settlement row;
 *        - deletes the Call row (ALWAYS).
 *
 *      Multi-call-per-batch trade-off: leaving the batch-level state intact
 *      when other Calls share the signature avoids corrupting cross-call
 *      attribution. The cost: RecipientEarnings becomes overcounted relative
 *      to the surviving SettlementRecipientShare sum until the remaining
 *      Calls in the batch are also rolled back (or the batch is otherwise
 *      reconciled). Documented in inline comment around the callsInBatch
 *      guard below.
 *
 * Dedup safety: the existing `(network, callId)` Call PK + tryInsertCall's
 * P2002 catch is sufficient for reorg-replay idempotency (D6 §4). This
 * service is for the OTHER side of the policy — surfacing orphans + giving
 * operators a safe atomic rollback primitive.
 */
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AdaptersService } from "../adapters/adapters.service";

export interface ReconcileResult {
  network: string;
  scanned: number;
  dbCalls: number;
  orphans: number;
  orphanCallIds: string[];
  /**
   * True when the scan was halted at SAFETY_CAP. Indicates `orphanCallIds`
   * is false-positive biased — any DB Call beyond the truncated window
   * appears orphaned even though it may exist on the canonical chain.
   */
  truncated: boolean;
}

@Injectable()
export class ReorgService {
  private readonly logger = new Logger(ReorgService.name);

  // Safety cap: never iterate the adapter's tail forever in a reconcile
  // pass. Production reconciles are bounded jobs; the cap guards against a
  // misconfigured fromBlock that would walk the chain indefinitely.
  private static readonly SAFETY_CAP = 50_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adaptersService: AdaptersService,
  ) {}

  /**
   * Tail finalized CallSettled events on `network` from `fromBlock` and
   * report any DB Call rows whose callId is NOT in the canonical-chain
   * window. Per D6 §5.2 this is DETECTION ONLY — no rows are mutated.
   *
   * @throws if the network has no registered adapter or the adapter does
   *         not expose `tailSettlementEvents` (e.g. SolanaAdapter, which
   *         relies on the settler push path instead).
   */
  async runReconcile(
    network: string,
    fromBlock: bigint,
  ): Promise<ReconcileResult> {
    const adapter = this.adaptersService.getAdapter(network);
    if (!adapter.tailSettlementEvents) {
      throw new Error(
        `adapter for network "${network}" does not expose tailSettlementEvents`,
      );
    }

    const seenCallIds = new Set<string>();
    let scanned = 0;

    for await (const e of adapter.tailSettlementEvents({
      fromBlockOrSlot: String(fromBlock),
    })) {
      seenCallIds.add(e.callId);
      scanned++;
      if (scanned >= ReorgService.SAFETY_CAP) break;
    }

    const dbCalls = await this.prisma.call.findMany({
      where: { network },
      select: { callId: true },
    });
    const orphanCallIds = dbCalls
      .map((c) => c.callId)
      .filter((id) => !seenCallIds.has(id));

    const truncated = scanned >= ReorgService.SAFETY_CAP;
    if (truncated) {
      this.logger.warn(
        `reorg reconcile TRUNCATED at SAFETY_CAP=${ReorgService.SAFETY_CAP}; orphans count is false-positive biased — re-run with a higher cap or paginate`,
      );
    }
    this.logger.log(
      `reorg reconcile network=${network} scanned=${scanned} dbCalls=${dbCalls.length} orphans=${orphanCallIds.length} truncated=${truncated}`,
    );
    return {
      network,
      scanned,
      dbCalls: dbCalls.length,
      orphans: orphanCallIds.length,
      orphanCallIds,
      truncated,
    };
  }

  /**
   * Operator-driven hard-reorg rollback per D6 §5.2 step 3.
   *
   * Atomic transaction:
   *   - decrement PoolState.currentBalanceLamports by Call.premiumLamports
   *   - decrement each affected RecipientEarnings.lifetimeEarnedLamports
   *     by the corresponding SettlementRecipientShare.amountLamports
   *   - if this is the ONLY Call in the batch (`signature`), delete the
   *     SettlementRecipientShare rows and the Settlement row
   *   - delete the Call row
   *
   * Note: multi-call-per-batch is supported safely — if other Calls in the
   * same Settlement remain, the Settlement + shares are left intact and only
   * this Call's row is deleted. Callers wanting to roll back the whole
   * batch must call `rollback` once per callId.
   *
   * @throws if the Call row does not exist.
   */
  async rollback(network: string, callId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const call = await tx.call.findUnique({
        where: { network_callId: { network, callId } },
      });
      if (!call) {
        throw new Error(`no Call row for network=${network} callId=${callId}`);
      }

      // 1) Roll back PoolState.currentBalanceLamports (the on-chain premium
      //    debit gets logically returned to the pool). Note we only adjust
      //    the running balance — totals (totalPremiumsLamports, etc.) are
      //    historical aggregates and are deliberately NOT mutated here.
      await tx.poolState.update({
        where: {
          network_endpointSlug: {
            network,
            endpointSlug: call.endpointSlug,
          },
        },
        data: {
          currentBalanceLamports: { decrement: call.premiumLamports },
        },
      });

      // 2) Roll back per-recipient lifetime earnings for shares attached to
      //    THIS batch (signature). When multiple Calls share the batch, the
      //    shares row is per-recipient at the batch level (summed across
      //    calls). We decrement by the full share amount here only if this
      //    is the single-call-per-batch path; in the multi-call path we
      //    leave shares + Settlement intact (see step 3) and skip earnings
      //    rollback to avoid corrupting cross-call attribution.
      const callsInBatch = await tx.call.count({
        where: { network, signature: call.signature },
      });

      if (callsInBatch === 1) {
        const shares = await tx.settlementRecipientShare.findMany({
          where: { network, settlementSig: call.signature },
        });
        for (const s of shares) {
          await tx.recipientEarnings.update({
            where: {
              network_recipientPubkey: {
                network,
                recipientPubkey: s.recipientPubkey,
              },
            },
            data: {
              lifetimeEarnedLamports: { decrement: s.amountLamports },
            },
          });
        }

        // 3) Single-call batch: delete shares + Settlement.
        await tx.settlementRecipientShare.deleteMany({
          where: { network, settlementSig: call.signature },
        });
        await tx.settlement.delete({
          where: { network_signature: { network, signature: call.signature } },
        });
      }

      // 4) Finally delete the Call row.
      await tx.call.delete({
        where: { network_callId: { network, callId } },
      });

      this.logger.log(
        `reorg rollback complete network=${network} callId=${callId} sig=${call.signature} multiCallBatch=${callsInBatch > 1}`,
      );
    });
  }
}
