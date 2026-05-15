import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@pact-network/db-zerog';
import {
  type PactCoreEvent,
  type CallSettledEvent,
  type RecipientPaidEvent,
  SettlementStatus,
} from '@pact-network/protocol-zerog-client';

/** Parsed 0G-Storage evidence blob (settler-evm/evidence.ts shape). */
export interface EvidenceData {
  latencyMs: number;
  outcome: string;
  breach: boolean;
  ts: string;
}

export interface BlockMeta {
  number: bigint;
  timestamp: Date;
}

/** Pre-fetched reconciliation data (all network I/O done by the reader,
 *  BEFORE the Prisma `$transaction` — Prisma 5.22 forbids slow I/O in-tx). */
export interface ProjectionCtx {
  /** callId → evidence (null if the 0G-Storage read failed). */
  evidence: Map<string, EvidenceData | null>;
  /** slug → current on-chain fee recipients (head read; structural kind). */
  feeRecipients: Map<string, { address: string; kind: number; bps: number }[]>;
  /** slug → reconciled EndpointConfig (only for slug-only ConfigUpdated). */
  endpointConfigs: Map<
    string,
    {
      agentTokenId: bigint;
      flatPremium: bigint;
      percentBps: number;
      imputedCost: bigint;
      latencySloMs: number;
      exposureCapPerHour: bigint;
      paused: boolean;
    }
  >;
}

const TREASURY = 0;
const AFFILIATE = 1;

interface PoolDelta {
  premium: bigint;
  paidOut: bigint;
  actualRefund: bigint;
}

/**
 * Applies one block's decoded PactCore events + the cursor advance in a single
 * Prisma `$transaction`. Idempotent: every row insert is guarded by a natural
 * unique key (`Call` PK / `txHash,logIndex`); aggregate counters + pool deltas
 * are accumulated ONLY from rows that actually inserted, so a replayed block
 * is a no-op. No network I/O here — `ctx` carries all reconciliation data.
 *
 * `ProtocolPaused` is process-memory only (re-read on boot by the reader).
 */
@Injectable()
export class ProjectionService {
  private readonly logger = new Logger(ProjectionService.name);
  private _protocolPaused = false;

  get protocolPaused(): boolean {
    return this._protocolPaused;
  }
  setProtocolPaused(v: boolean): void {
    this._protocolPaused = v;
  }

  async applyBlock(
    tx: Prisma.TransactionClient,
    block: BlockMeta,
    events: PactCoreEvent[],
    ctx: ProjectionCtx,
  ): Promise<void> {
    const ts = block.timestamp;
    const poolDeltas = new Map<string, PoolDelta>();
    const bump = (slug: string, k: keyof PoolDelta, v: bigint) => {
      const d = poolDeltas.get(slug) ?? {
        premium: 0n,
        paidOut: 0n,
        actualRefund: 0n,
      };
      d[k] += v;
      poolDeltas.set(slug, d);
    };

    // ── pass 1: config/pool/endpoint + CallSettled (creates Settlement) ──
    for (const ev of events) {
      switch (ev.eventName) {
        case 'EndpointRegistered':
          await this.ensureEndpoint(tx, ev.slug, ts);
          await tx.endpoint.update({
            where: { slug: ev.slug },
            data: {
              agentTokenId: ev.agentTokenId.toString(),
              flatPremiumWei: ev.flatPremium,
              percentBps: ev.percentBps,
              imputedCostWei: ev.imputedCost,
              latencySloMs: ev.latencySloMs,
              exposureCapPerHourWei: ev.exposureCapPerHour,
              lastUpdated: ts,
            },
          });
          await this.rebuildFeeRecipients(tx, ev.slug, ctx);
          break;

        case 'EndpointConfigUpdated': {
          const cfg = ctx.endpointConfigs.get(ev.slug);
          await this.ensureEndpoint(tx, ev.slug, ts);
          if (cfg) {
            await tx.endpoint.update({
              where: { slug: ev.slug },
              data: {
                agentTokenId: cfg.agentTokenId.toString(),
                flatPremiumWei: cfg.flatPremium,
                percentBps: cfg.percentBps,
                imputedCostWei: cfg.imputedCost,
                latencySloMs: cfg.latencySloMs,
                exposureCapPerHourWei: cfg.exposureCapPerHour,
                paused: cfg.paused,
                lastUpdated: ts,
              },
            });
          }
          break;
        }

        case 'FeeRecipientsUpdated':
          await this.ensureEndpoint(tx, ev.slug, ts);
          await this.rebuildFeeRecipients(tx, ev.slug, ctx);
          break;

        case 'PoolToppedUp':
          await this.ensureEndpoint(tx, ev.slug, ts);
          await tx.poolState.upsert({
            where: { endpointSlug: ev.slug },
            create: {
              endpointSlug: ev.slug,
              currentBalanceWei: ev.amount,
              totalDepositsWei: ev.amount,
              totalPremiumsWei: 0n,
              totalFeesPaidWei: 0n,
              totalRefundsWei: 0n,
              lastUpdated: ts,
            },
            update: {
              currentBalanceWei: { increment: ev.amount },
              totalDepositsWei: { increment: ev.amount },
              lastUpdated: ts,
            },
          });
          break;

        case 'EndpointPaused':
          await this.ensureEndpoint(tx, ev.slug, ts);
          await tx.endpoint.update({
            where: { slug: ev.slug },
            data: { paused: ev.paused, lastUpdated: ts },
          });
          break;

        case 'ProtocolPaused':
          this._protocolPaused = ev.paused;
          break;

        case 'CallSettled':
          await this.handleCallSettled(tx, ev, block, ts, ctx, bump);
          break;

        case 'RecipientPaid':
          break; // pass 2
      }
    }

    // ── pass 2: RecipientPaid (Settlement rows now exist) ──
    for (const ev of events) {
      if (ev.eventName !== 'RecipientPaid') continue;
      await this.handleRecipientPaid(tx, ev, ts, ctx, bump);
    }

    // ── apply accumulated per-slug pool deltas (delta-derived) ──
    for (const [slug, d] of poolDeltas) {
      if (d.premium === 0n && d.paidOut === 0n && d.actualRefund === 0n) continue;
      await tx.poolState.upsert({
        where: { endpointSlug: slug },
        create: {
          endpointSlug: slug,
          currentBalanceWei: d.premium - d.paidOut - d.actualRefund,
          totalDepositsWei: 0n,
          totalPremiumsWei: d.premium,
          totalFeesPaidWei: d.paidOut,
          totalRefundsWei: d.actualRefund,
          lastUpdated: ts,
        },
        update: {
          currentBalanceWei: { increment: d.premium - d.paidOut - d.actualRefund },
          totalPremiumsWei: { increment: d.premium },
          totalFeesPaidWei: { increment: d.paidOut },
          totalRefundsWei: { increment: d.actualRefund },
          lastUpdated: ts,
        },
      });
    }

    // ── cursor advance — atomic with this block's writes ──
    await tx.indexerCursor.upsert({
      where: { id: 'pactcore' },
      create: { id: 'pactcore', lastBlock: block.number, updatedAt: ts },
      update: { lastBlock: block.number, updatedAt: ts },
    });
  }

  private async handleCallSettled(
    tx: Prisma.TransactionClient,
    ev: CallSettledEvent,
    block: BlockMeta,
    ts: Date,
    ctx: ProjectionCtx,
    bump: (slug: string, k: keyof PoolDelta, v: bigint) => void,
  ): Promise<void> {
    const ev_ = ev;
    const evidence = ctx.evidence.get(ev_.callId) ?? null;
    const isSettled = ev_.status === SettlementStatus.Settled;
    const breach = evidence
      ? evidence.breach
      : ev_.status === SettlementStatus.PoolDepleted ||
        ev_.status === SettlementStatus.ExposureCapClamped ||
        (isSettled && ev_.actualRefund > 0n);
    const breachReason = breach ? (evidence?.outcome ?? null) : null;
    const callTs = evidence?.ts ? new Date(evidence.ts) : ts;

    await this.ensureEndpoint(tx, ev_.slug, ts);
    await this.ensureAgent(tx, ev_.agent, ts);

    try {
      await tx.call.create({
        data: {
          callId: ev_.callId,
          agentAddress: ev_.agent,
          endpointSlug: ev_.slug,
          premiumWei: ev_.premium,
          refundWei: ev_.actualRefund,
          requestedRefundWei: ev_.refund,
          latencyMs: evidence?.latencyMs ?? null,
          breach,
          breachReason,
          status: ev_.status,
          evidenceRootHash: ev_.rootHash,
          source: null,
          ts: callTs,
          settledAt: ts,
          txHash: ev_.txHash,
          blockNumber: ev_.blockNumber,
          logIndex: ev_.logIndex,
        },
      });
    } catch (e) {
      if (this.isP2002(e)) return; // replay — skip ALL aggregates for this log
      throw e;
    }

    // inserted → counters + pool delta
    await tx.agent.update({
      where: { address: ev_.agent },
      data: {
        callCount: { increment: 1 },
        totalPremiumsWei: { increment: ev_.premium },
        totalRefundsWei: { increment: ev_.actualRefund },
        lastCallAt: callTs,
      },
    });
    bump(ev_.slug, 'premium', ev_.premium);
    bump(ev_.slug, 'actualRefund', ev_.actualRefund);

    // one Settlement per batch tx (created on first inserted CallSettled).
    await tx.settlement.upsert({
      where: { txHash: ev_.txHash },
      create: {
        txHash: ev_.txHash,
        blockNumber: block.number,
        batchSize: 1,
        totalPremiumsWei: ev_.premium,
        totalRefundsWei: ev_.actualRefund,
        ts,
      },
      update: {
        batchSize: { increment: 1 },
        totalPremiumsWei: { increment: ev_.premium },
        totalRefundsWei: { increment: ev_.actualRefund },
      },
    });
  }

  private async handleRecipientPaid(
    tx: Prisma.TransactionClient,
    ev: RecipientPaidEvent,
    ts: Date,
    ctx: ProjectionCtx,
    bump: (slug: string, k: keyof PoolDelta, v: bigint) => void,
  ): Promise<void> {
    // structural kind: Treasury iff recipient is the endpoint's known
    // Treasury, else Affiliate (the Treasury is the stable recipient).
    const recips = ctx.feeRecipients.get(ev.slug) ?? [];
    const treasury = recips.find((r) => r.kind === TREASURY);
    const kind =
      treasury &&
      treasury.address.toLowerCase() === ev.recipient.toLowerCase()
        ? TREASURY
        : AFFILIATE;

    try {
      await tx.settlementRecipientShare.create({
        data: {
          settlementTx: ev.txHash,
          logIndex: ev.logIndex,
          blockNumber: ev.blockNumber,
          recipientKind: kind,
          recipientAddress: ev.recipient,
          amountWei: ev.amount,
        },
      });
    } catch (e) {
      if (this.isP2002(e)) return; // replay — skip earnings + pool delta
      throw e;
    }

    await tx.recipientEarnings.upsert({
      where: {
        endpointSlug_recipientAddress: {
          endpointSlug: ev.slug,
          recipientAddress: ev.recipient,
        },
      },
      create: {
        endpointSlug: ev.slug,
        recipientAddress: ev.recipient,
        recipientKind: kind,
        lifetimeEarnedWei: ev.amount,
        lastUpdated: ts,
      },
      update: {
        lifetimeEarnedWei: { increment: ev.amount },
        recipientKind: kind,
        lastUpdated: ts,
      },
    });
    bump(ev.slug, 'paidOut', ev.amount);
  }

  /** Lazy FK target — minimal Endpoint so Call/PoolState inserts never fail.
   *  Real fields land via EndpointRegistered/ConfigUpdated; never clobber
   *  off-chain `displayName`/`upstream*`. */
  private async ensureEndpoint(
    tx: Prisma.TransactionClient,
    slug: string,
    ts: Date,
  ): Promise<void> {
    await tx.endpoint.upsert({
      where: { slug },
      create: {
        slug,
        agentTokenId: '0',
        flatPremiumWei: 0n,
        percentBps: 0,
        imputedCostWei: 0n,
        latencySloMs: 0,
        exposureCapPerHourWei: 0n,
        paused: true,
        registeredAt: ts,
        lastUpdated: ts,
      },
      update: {},
    });
  }

  private async ensureAgent(
    tx: Prisma.TransactionClient,
    address: string,
    ts: Date,
  ): Promise<void> {
    await tx.agent.upsert({
      where: { address },
      create: { address, createdAt: ts },
      update: {},
    });
  }

  private async rebuildFeeRecipients(
    tx: Prisma.TransactionClient,
    slug: string,
    ctx: ProjectionCtx,
  ): Promise<void> {
    const recips = ctx.feeRecipients.get(slug) ?? [];
    await tx.feeRecipient.deleteMany({ where: { endpointSlug: slug } });
    if (recips.length > 0) {
      await tx.feeRecipient.createMany({
        data: recips.map((r) => ({
          endpointSlug: slug,
          recipientAddress: r.address,
          kind: r.kind,
          bps: r.bps,
        })),
      });
    }
  }

  private isP2002(e: unknown): boolean {
    return (
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
    );
  }
}
