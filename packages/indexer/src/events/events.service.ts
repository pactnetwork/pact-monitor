import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SettlementEventDto } from "./events.dto";

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(dto: SettlementEventDto): Promise<{ accepted: number }> {
    let accepted = 0;

    await this.prisma.$transaction(async (tx) => {
      // Upsert settlement record
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

      for (const call of dto.calls) {
        // Upsert agent (create if first seen)
        await tx.agent.upsert({
          where: { pubkey: call.agentPubkey },
          create: {
            pubkey: call.agentPubkey,
            walletPda: call.agentPubkey,
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

        // Idempotent call insert — skip on PK conflict
        const existing = await tx.call.findUnique({
          where: { callId: call.callId },
          select: { callId: true },
        });
        if (existing) continue;

        await tx.call.create({
          data: {
            callId: call.callId,
            agentPubkey: call.agentPubkey,
            endpointSlug: call.endpointSlug,
            premiumLamports: BigInt(call.premiumLamports),
            refundLamports: BigInt(call.refundLamports),
            latencyMs: call.latencyMs,
            breach: call.breach,
            breachReason: call.breachReason ?? null,
            source: call.source ?? null,
            ts: new Date(call.ts),
            settledAt: new Date(call.settledAt),
            signature: call.signature,
          },
        });
        accepted++;
      }

      // Update PoolState singleton (upsert id=1)
      const totalPremium = dto.calls.reduce(
        (s, c) => s + BigInt(c.premiumLamports),
        0n,
      );
      const totalRefund = dto.calls.reduce(
        (s, c) => s + BigInt(c.refundLamports),
        0n,
      );
      await tx.poolState.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          currentBalanceLamports: totalPremium - totalRefund,
          totalDepositsLamports: 0n,
          totalPremiumsLamports: totalPremium,
          totalRefundsLamports: totalRefund,
          lastUpdated: new Date(),
        },
        update: {
          currentBalanceLamports: {
            increment: totalPremium - totalRefund,
          },
          totalPremiumsLamports: { increment: totalPremium },
          totalRefundsLamports: { increment: totalRefund },
          lastUpdated: new Date(),
        },
      });
    });

    return { accepted };
  }
}
