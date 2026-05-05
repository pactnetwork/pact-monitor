import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  RecipientShareDto,
  SettlementEventDto,
  outcomeToBreach,
} from "./events.dto";

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(dto: SettlementEventDto): Promise<{ accepted: number }> {
    let accepted = 0;

    await this.prisma.$transaction(async (tx) => {
      // Upsert settlement record (idempotent by signature).
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

      // Insert per-recipient shares once. We treat the (signature, kind,
      // pubkey) tuple as the unique key — but we use the `cuid` PK and
      // skip insert if any share already exists for this signature.
      const existingShares = await tx.settlementRecipientShare.count({
        where: { settlementSig: dto.signature },
      });
      const shares: RecipientShareDto[] = dto.shares ?? [];
      if (existingShares === 0 && shares.length > 0) {
        await tx.settlementRecipientShare.createMany({
          data: shares.map((s) => ({
            settlementSig: dto.signature,
            recipientKind: s.recipientKind,
            recipientPubkey: s.recipientPubkey,
            amountLamports: BigInt(s.amountLamports),
          })),
        });

        // Update lifetime earnings per recipient.
        for (const s of shares) {
          const amt = BigInt(s.amountLamports);
          await tx.recipientEarnings.upsert({
            where: { recipientPubkey: s.recipientPubkey },
            create: {
              recipientPubkey: s.recipientPubkey,
              recipientKind: s.recipientKind,
              lifetimeEarnedLamports: amt,
              lastUpdated: new Date(dto.ts),
            },
            update: {
              lifetimeEarnedLamports: { increment: amt },
              lastUpdated: new Date(dto.ts),
            },
          });
        }
      }

      // Per-endpoint pool deltas computed from this batch's calls.
      const perEndpoint = new Map<
        string,
        { premium: bigint; refund: bigint; feesPaid: bigint }
      >();

      for (const call of dto.calls) {
        // Upsert agent (no walletPda — agent custody, no PDA in v1).
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

        // Idempotent call insert — skip on PK conflict.
        const existing = await tx.call.findUnique({
          where: { callId: call.callId },
          select: { callId: true },
        });
        if (existing) continue;

        const { breach, breachReason } = outcomeToBreach(call.outcome);

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
        accepted++;

        // Accumulate per-endpoint deltas for PoolState.
        const slot = perEndpoint.get(call.endpointSlug) ?? {
          premium: 0n,
          refund: 0n,
          feesPaid: 0n,
        };
        slot.premium += BigInt(call.premiumLamports);
        slot.refund += BigInt(call.refundLamports);
        perEndpoint.set(call.endpointSlug, slot);
      }

      // Distribute totalFeesPaid (sum of shares amounts) across endpoints
      // proportional to gross premiums in this batch. The settler only
      // tells us total fees, not per-endpoint, so we apportion. This is a
      // best-effort attribution; per-endpoint exact split would require
      // settler to send per-call fee deltas (out of scope for now).
      const totalFees = shares.reduce(
        (s, x) => s + BigInt(x.amountLamports),
        0n,
      );
      const totalPremiumThisBatch = Array.from(perEndpoint.values()).reduce(
        (s, v) => s + v.premium,
        0n,
      );
      if (totalFees > 0n && totalPremiumThisBatch > 0n) {
        let feesAssigned = 0n;
        const slugs = Array.from(perEndpoint.keys());
        slugs.forEach((slug, i) => {
          const slot = perEndpoint.get(slug)!;
          // Last endpoint absorbs rounding remainder so totals reconcile.
          const fee =
            i === slugs.length - 1
              ? totalFees - feesAssigned
              : (totalFees * slot.premium) / totalPremiumThisBatch;
          slot.feesPaid = fee;
          feesAssigned += fee;
        });
      }

      // Per-endpoint PoolState upserts. PoolState row exists only if its
      // Endpoint row exists; if we receive a call for an unknown endpoint
      // we skip the pool update (the endpoint reader/registrar is owned
      // elsewhere). Currentbalance increments by (premium - refund - fees).
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
    });

    return { accepted };
  }
}
