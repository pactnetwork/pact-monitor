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

    return this.prisma.$transaction(async (tx) => {
      // First pass: insert each Call. Duplicates (P2002 on callId PK) are
      // skipped silently. Only successfully-inserted calls drive aggregate
      // updates.
      const insertedCalls: WrapCallEventDto[] = [];
      for (const call of dto.calls) {
        const inserted = await this.tryInsertCall(tx, call);
        if (inserted) insertedCalls.push(call);
      }

      // If every call was a duplicate, the entire batch is a no-op. Do not
      // touch Agent / Endpoint / Settlement / RecipientEarnings — the
      // aggregates were already applied during the first delivery.
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
      const perEndpoint = new Map<string, PoolDelta>();
      const perRecipient = new Map<string, { kind: number; pubkey: string; amount: bigint }>();

      for (const call of insertedCalls) {
        // Bump Agent counters. Safe to do here because we know this call is
        // a brand-new row, not a redelivery.
        await tx.agent.upsert({
          where: { pubkey: call.agentPubkey },
          create: {
            pubkey: call.agentPubkey,
            createdAt: new Date(call.ts),
            lastCallAt: new Date(call.ts),
            callCount: 1n,
            totalPremiumsLamports: BigInt(call.premiumLamports),
            totalRefundsLamports: BigInt(call.refundLamports),
          },
          update: {
            lastCallAt: new Date(call.ts),
            callCount: { increment: 1n },
            totalPremiumsLamports: { increment: BigInt(call.premiumLamports) },
            totalRefundsLamports: { increment: BigInt(call.refundLamports) },
          },
        });

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

        for (const s of aggregatedShares) {
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

      // PoolState upserts. Skip endpoints that have no registered Endpoint
      // row — endpoint registration is owned elsewhere.
      for (const [slug, delta] of perEndpoint.entries()) {
        const endpointExists = await tx.endpoint.findUnique({
          where: { slug },
          select: { slug: true },
        });
        if (!endpointExists) continue;

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
