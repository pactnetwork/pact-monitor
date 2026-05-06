import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@pact-network/db";
import { PrismaService } from "../prisma/prisma.service";
import {
  SettlementEventDto,
  WrapCallEventDto,
  outcomeToBreach,
} from "./events.dto";

/**
 * Per-endpoint pool deltas computed during a single batch ingest. Only filled
 * for calls that were actually inserted (i.e. not duplicates).
 */
interface PoolDelta {
  premium: bigint;
  refund: bigint;
  feesPaid: bigint;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ingest a batch settlement event from the settler.
   *
   * Idempotency contract (codex review #59):
   *   - The Call row is the source of truth. Only on a real INSERT do we
   *     mutate Agent counters / Endpoint pool state / SettlementRecipientShare
   *     / RecipientEarnings.
   *   - A duplicate Pub/Sub redelivery (same `callId`) is detected via the
   *     P2002 unique-constraint error from `prisma.call.create()`. On conflict
   *     we skip every aggregate update for that call.
   *   - Settlement-level rows (Settlement, SettlementRecipientShare,
   *     RecipientEarnings) are guarded by `signature` and only inserted when
   *     at least one new Call row was created in this batch — otherwise the
   *     entire batch was a no-op duplicate.
   *   - Everything happens inside a single `prisma.$transaction(...)` so
   *     aggregate updates roll back if any insert fails.
   *
   * FK + concurrency contract (B11 / B12):
   *   - B11: Call has FKs to Agent (pubkey) and Endpoint (slug). On a green
   *     DB the very first call from a brand-new agent would 500 with
   *     `Call_agentPubkey_fkey`. We now upsert all referenced Agent + Endpoint
   *     rows BEFORE any Call.create inside the same tx, so FK targets exist.
   *     Endpoint rows are lazy-created with paused=true and zeroed business
   *     fields — admin must overwrite them via on-chain registration before
   *     they participate in real rate computation. Agent rows are pure
   *     metadata (pubkey + counters) so lazy-create is fine.
   *   - B12: two settler instances posting concurrent batches that share an
   *     agent or endpoint deadlocked on row-locks taken in different orders.
   *     We now sort all (agent pubkey, endpoint slug) sets lexicographically
   *     before upserting them. Two transactions therefore acquire the same
   *     row-locks in the same order → they serialize, never deadlock.
   *
   * Shares contract:
   *   - Per-call `shares` is REQUIRED on every WrapCallEventDto (possibly
   *     empty array, never absent). Missing `shares` is a 400 — settler
   *     contract drift would otherwise silently zero out Treasury / affiliate
   *     fee attribution forever.
   *   - We aggregate per-call shares across the batch into RecipientEarnings
   *     by (kind, pubkey). Endpoint feesPaid is the exact sum of shares from
   *     the calls that hit that endpoint — no more proportional apportioning.
   */
  async ingest(dto: SettlementEventDto): Promise<{ accepted: number }> {
    // Validate the per-call shares contract up front. An undefined `shares`
    // field is treated as a contract violation rather than coerced to `[]` —
    // we want the settler to fail loudly if it ever stops emitting shares.
    for (const call of dto.calls) {
      if (!Array.isArray(call.shares)) {
        throw new BadRequestException(
          `WrapCallEventDto.shares must be an array (callId=${call.callId}); ` +
            `emit [] for no-fee calls. See events.dto.ts.`,
        );
      }
    }

    // Deduplicate + lex-sort all FK targets touched by this batch. Sorting is
    // load-bearing: it gives concurrent ingest transactions a deterministic
    // lock-acquisition order, so two settlers writing the same Agent / Endpoint
    // rows at the same time cannot deadlock (B12).
    //
    // We pick the *earliest* observed call timestamp for each agent so the
    // create-branch's `createdAt` is stable across redeliveries and parallel
    // batches — different batches won't clobber it with a later ts.
    const earliestTsByAgent = new Map<string, string>();
    for (const call of dto.calls) {
      const prev = earliestTsByAgent.get(call.agentPubkey);
      if (prev === undefined || call.ts < prev) {
        earliestTsByAgent.set(call.agentPubkey, call.ts);
      }
    }
    const sortedAgentPubkeys = Array.from(earliestTsByAgent.keys()).sort();
    const sortedEndpointSlugs = Array.from(
      new Set(dto.calls.map((c) => c.endpointSlug)),
    ).sort();

    return this.prisma.$transaction(async (tx) => {
      // === FK PREP (B11) ===
      // Upsert all referenced Agent and Endpoint rows in deterministic lex
      // order BEFORE any Call.create. This ensures:
      //   1. Call.create's FK targets exist (no FK violation 500 on first
      //      call from a brand-new agent).
      //   2. Concurrent batches sharing rows take row-locks in the same
      //      order → no PG deadlock (40P01).
      //
      // These upserts touch only stable identity columns. We do NOT bump
      // counters or pool deltas here — those still happen post Call.create
      // so a duplicate redelivery (every call P2002s) remains a clean no-op.

      for (const pubkey of sortedAgentPubkeys) {
        const ts = new Date(earliestTsByAgent.get(pubkey)!);
        await tx.agent.upsert({
          where: { pubkey },
          create: {
            pubkey,
            createdAt: ts,
            // counters all default to 0 in the schema; bumped post-insert
          },
          update: {},
        });
      }

      for (const slug of sortedEndpointSlugs) {
        // Lazy-create with paused=true + zeroed business fields. Admin must
        // overwrite these via on-chain endpoint registration ingestion before
        // the endpoint participates in rate / pool computation. We still
        // record PoolState deltas below so the observed call activity isn't
        // lost when registration eventually lands.
        await tx.endpoint.upsert({
          where: { slug },
          create: {
            slug,
            flatPremiumLamports: 0n,
            percentBps: 0,
            slaLatencyMs: 0,
            imputedCostLamports: 0n,
            exposureCapPerHourLamports: 0n,
            paused: true,
            upstreamBase: "",
            displayName: slug,
            registeredAt: new Date(dto.ts),
            lastUpdated: new Date(dto.ts),
          },
          update: {},
        });
      }

      // === CALL INSERTS ===
      // Insert each Call. Duplicates (P2002 on callId PK) are skipped
      // silently. Only successfully-inserted calls drive aggregate updates.
      const insertedCalls: WrapCallEventDto[] = [];
      for (const call of dto.calls) {
        const inserted = await this.tryInsertCall(tx, call);
        if (inserted) insertedCalls.push(call);
      }

      // If every call was a duplicate, the entire batch is a no-op for
      // counters / pool / settlement aggregates. The Agent + Endpoint upserts
      // above are also no-ops in that case (update: {}), so total work is
      // exactly that — no double-counting.
      if (insertedCalls.length === 0) {
        return { accepted: 0 };
      }

      // Settlement record — idempotent by signature. Only created when the
      // batch contains at least one new call.
      await tx.settlement.upsert({
        where: { signature: dto.signature },
        create: {
          signature: dto.signature,
          batchSize: dto.batchSize,
          totalPremiumsLamports: BigInt(dto.totalPremiumsLamports),
          totalRefundsLamports: BigInt(dto.totalRefundsLamports),
          ts: new Date(dto.ts),
        },
        update: {},
      });

      // Aggregate per-call shares into:
      //   - One flat list per (kind, pubkey) for SettlementRecipientShare
      //     batch rows + RecipientEarnings upserts.
      //   - Per-endpoint feesPaid totals for PoolState updates.
      //   - Per-agent counter deltas — applied via a SECOND pass below in
      //     the same lex order as the FK-prep upserts to preserve the
      //     deterministic lock order (B12).
      const perEndpoint = new Map<string, PoolDelta>();
      const perRecipient = new Map<string, { kind: number; pubkey: string; amount: bigint }>();
      const perAgent = new Map<
        string,
        {
          callCount: bigint;
          premium: bigint;
          refund: bigint;
          lastCallAt: Date;
        }
      >();

      for (const call of insertedCalls) {
        const agentSlot = perAgent.get(call.agentPubkey) ?? {
          callCount: 0n,
          premium: 0n,
          refund: 0n,
          lastCallAt: new Date(call.ts),
        };
        agentSlot.callCount += 1n;
        agentSlot.premium += BigInt(call.premiumLamports);
        agentSlot.refund += BigInt(call.refundLamports);
        const callTs = new Date(call.ts);
        if (callTs > agentSlot.lastCallAt) agentSlot.lastCallAt = callTs;
        perAgent.set(call.agentPubkey, agentSlot);

        const slot = perEndpoint.get(call.endpointSlug) ?? {
          premium: 0n,
          refund: 0n,
          feesPaid: 0n,
        };
        slot.premium += BigInt(call.premiumLamports);
        slot.refund += BigInt(call.refundLamports);

        // Per-call shares: this call's exact fee fan-out lands on this
        // endpoint's pool (no proportional apportioning across endpoints).
        for (const share of call.shares) {
          const amt = BigInt(share.amountLamports);
          slot.feesPaid += amt;

          const key = `${share.kind}:${share.pubkey}`;
          const agg = perRecipient.get(key) ?? {
            kind: share.kind,
            pubkey: share.pubkey,
            amount: 0n,
          };
          agg.amount += amt;
          perRecipient.set(key, agg);
        }
        perEndpoint.set(call.endpointSlug, slot);
      }

      // Apply Agent counter bumps in the SAME lex order used for the FK-prep
      // upserts. Concurrent batches sharing an Agent will take this UPDATE
      // lock in identical order → no deadlock.
      for (const pubkey of sortedAgentPubkeys) {
        const delta = perAgent.get(pubkey);
        if (!delta) continue; // every call for this agent was a duplicate
        await tx.agent.update({
          where: { pubkey },
          data: {
            lastCallAt: delta.lastCallAt,
            callCount: { increment: delta.callCount },
            totalPremiumsLamports: { increment: delta.premium },
            totalRefundsLamports: { increment: delta.refund },
          },
        });
      }

      // Per-recipient settlement shares: insert once per signature.
      // SettlementRecipientShare is keyed at the batch level (per-batch row
      // per recipient) — we sum each (kind, pubkey) across the batch's calls.
      const aggregatedShares = Array.from(perRecipient.values());
      const existingShares = await tx.settlementRecipientShare.count({
        where: { settlementSig: dto.signature },
      });
      if (existingShares === 0 && aggregatedShares.length > 0) {
        await tx.settlementRecipientShare.createMany({
          data: aggregatedShares.map((s) => ({
            settlementSig: dto.signature,
            recipientKind: s.kind,
            recipientPubkey: s.pubkey,
            amountLamports: s.amount,
          })),
        });

        // Lex-sort recipient pubkeys for deterministic lock order (B12).
        const sortedRecipients = [...aggregatedShares].sort((a, b) =>
          a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0,
        );
        for (const s of sortedRecipients) {
          await tx.recipientEarnings.upsert({
            where: { recipientPubkey: s.pubkey },
            create: {
              recipientPubkey: s.pubkey,
              recipientKind: s.kind,
              lifetimeEarnedLamports: s.amount,
              lastUpdated: new Date(dto.ts),
            },
            update: {
              lifetimeEarnedLamports: { increment: s.amount },
              lastUpdated: new Date(dto.ts),
            },
          });
        }
      }

      // PoolState upserts in the SAME lex order used above (B12). Endpoint
      // existence is now guaranteed by the FK-prep upsert pass.
      for (const slug of sortedEndpointSlugs) {
        const delta = perEndpoint.get(slug);
        if (!delta) continue; // every call for this endpoint was a duplicate

        const balanceDelta = delta.premium - delta.refund - delta.feesPaid;
        await tx.poolState.upsert({
          where: { endpointSlug: slug },
          create: {
            endpointSlug: slug,
            currentBalanceLamports: balanceDelta,
            totalDepositsLamports: 0n,
            totalPremiumsLamports: delta.premium,
            totalFeesPaidLamports: delta.feesPaid,
            totalRefundsLamports: delta.refund,
            lastUpdated: new Date(dto.ts),
          },
          update: {
            currentBalanceLamports: { increment: balanceDelta },
            totalPremiumsLamports: { increment: delta.premium },
            totalFeesPaidLamports: { increment: delta.feesPaid },
            totalRefundsLamports: { increment: delta.refund },
            lastUpdated: new Date(dto.ts),
          },
        });
      }

      return { accepted: insertedCalls.length };
    });
  }

  /**
   * Insert a Call row, returning true if a brand-new row was created or
   * false if this `callId` already existed (P2002 unique-constraint).
   *
   * We deliberately do NOT swallow other Prisma errors — they should bubble
   * up and abort the surrounding transaction so aggregate updates roll back.
   */
  private async tryInsertCall(
    tx: Prisma.TransactionClient,
    call: WrapCallEventDto,
  ): Promise<boolean> {
    const { breach, breachReason } = outcomeToBreach(call.outcome);
    try {
      await tx.call.create({
        data: {
          callId: call.callId,
          agentPubkey: call.agentPubkey,
          endpointSlug: call.endpointSlug,
          premiumLamports: BigInt(call.premiumLamports),
          refundLamports: BigInt(call.refundLamports),
          latencyMs: call.latencyMs,
          breach,
          breachReason,
          source: call.source ?? null,
          ts: new Date(call.ts),
          settledAt: new Date(call.settledAt),
          signature: call.signature,
        },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        this.logger.debug(
          `duplicate call insert ignored callId=${call.callId} sig=${call.signature}`,
        );
        return false;
      }
      throw err;
    }
  }
}
