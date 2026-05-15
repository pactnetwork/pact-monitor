import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@pact-network/db-zerog';
import { SettlementStatus } from '@pact-network/protocol-zerog-client';
import {
  ProjectionService,
  type ProjectionCtx,
  type BlockMeta,
} from './projection.service';

function mockTx() {
  const m = () => vi.fn().mockResolvedValue(undefined);
  return {
    endpoint: { upsert: m(), update: m() },
    agent: { upsert: m(), update: m() },
    call: { create: m() },
    settlement: { upsert: m() },
    settlementRecipientShare: { create: m() },
    recipientEarnings: { upsert: m() },
    poolState: { upsert: m() },
    feeRecipient: { deleteMany: m(), createMany: m() },
    indexerCursor: { upsert: m() },
  };
}
const block: BlockMeta = { number: 100n, timestamp: new Date('2026-05-15T12:00:00Z') };
const emptyCtx = (): ProjectionCtx => ({
  evidence: new Map(),
  feeRecipients: new Map(),
  endpointConfigs: new Map(),
});
const SLUG = '0x68656c69757300000000000000000000' as `0x${string}`;
const AGENT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const TX = '0xtx' as `0x${string}`;
const meta = (logIndex: number) =>
  ({ txHash: TX, logIndex, blockNumber: 100n }) as const;
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });

describe('ProjectionService', () => {
  let svc: ProjectionService;
  let tx: ReturnType<typeof mockTx>;
  beforeEach(() => {
    svc = new ProjectionService();
    tx = mockTx();
  });

  it('always advances the cursor, even with no events', async () => {
    await svc.applyBlock(tx as never, block, [], emptyCtx());
    expect(tx.indexerCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pactcore' } }),
    );
  });

  it('EndpointRegistered maps pricing + rebuilds fee recipients', async () => {
    const ctx = emptyCtx();
    ctx.feeRecipients.set(SLUG, [
      { address: AGENT, kind: 0, bps: 1000 },
    ]);
    await svc.applyBlock(
      tx as never,
      block,
      [
        {
          eventName: 'EndpointRegistered',
          ...meta(0),
          slug: SLUG,
          agentTokenId: 42n,
          flatPremium: 500n,
          percentBps: 50,
          imputedCost: 7n,
          latencySloMs: 5000,
          exposureCapPerHour: 9000n,
        },
      ],
      ctx,
    );
    expect(tx.endpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: SLUG },
        data: expect.objectContaining({
          flatPremiumWei: 500n,
          percentBps: 50,
          imputedCostWei: 7n,
          agentTokenId: '42',
        }),
      }),
    );
    expect(tx.feeRecipient.deleteMany).toHaveBeenCalled();
    expect(tx.feeRecipient.createMany).toHaveBeenCalledWith({
      data: [{ endpointSlug: SLUG, recipientAddress: AGENT, kind: 0, bps: 1000 }],
    });
  });

  it('CallSettled non-breach: refundWei=actualRefund, requested kept, latency null, counters bumped', async () => {
    await svc.applyBlock(
      tx as never,
      block,
      [
        {
          eventName: 'CallSettled',
          ...meta(0),
          callId: '0xcall1',
          slug: SLUG,
          agent: AGENT,
          status: SettlementStatus.Settled,
          premium: 1000n,
          refund: 0n,
          actualRefund: 0n,
          rootHash: '0xrh',
        },
      ],
      emptyCtx(),
    );
    const data = tx.call.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      premiumWei: 1000n,
      refundWei: 0n,
      requestedRefundWei: 0n,
      latencyMs: null,
      breach: false,
      breachReason: null,
      status: SettlementStatus.Settled,
    });
    expect(tx.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          callCount: { increment: 1 },
          totalPremiumsWei: { increment: 1000n },
        }),
      }),
    );
    expect(tx.settlement.upsert).toHaveBeenCalled();
  });

  it('CallSettled breach via evidence sets breachReason + latency', async () => {
    const ctx = emptyCtx();
    ctx.evidence.set('0xc', {
      latencyMs: 8000,
      outcome: 'latency_breach',
      breach: true,
      ts: '2026-05-15T11:59:00Z',
    });
    await svc.applyBlock(
      tx as never,
      block,
      [
        {
          eventName: 'CallSettled',
          ...meta(0),
          callId: '0xc',
          slug: SLUG,
          agent: AGENT,
          status: SettlementStatus.Settled,
          premium: 1000n,
          refund: 5000n,
          actualRefund: 5000n,
          rootHash: '0xrh',
        },
      ],
      ctx,
    );
    expect(tx.call.create.mock.calls[0][0].data).toMatchObject({
      latencyMs: 8000,
      breach: true,
      breachReason: 'latency_breach',
      refundWei: 5000n,
      requestedRefundWei: 5000n,
    });
  });

  it.each([
    [SettlementStatus.DelegateFailed, 0n, false],
    [SettlementStatus.PoolDepleted, 3n, true],
    [SettlementStatus.ExposureCapClamped, 1n, true],
    [SettlementStatus.Settled, 0n, false],
    [SettlementStatus.Settled, 9n, true],
  ])('breach rule without evidence: status=%s actualRefund=%s → %s', async (status, ar, expected) => {
    await svc.applyBlock(
      tx as never,
      block,
      [
        {
          eventName: 'CallSettled',
          ...meta(0),
          callId: '0xc',
          slug: SLUG,
          agent: AGENT,
          status: status as SettlementStatus,
          premium: 1000n,
          refund: 9n,
          actualRefund: ar as bigint,
          rootHash: '0xrh',
        },
      ],
      emptyCtx(),
    );
    expect(tx.call.create.mock.calls[0][0].data.breach).toBe(expected);
  });

  it('idempotent: Call P2002 skips agent/settlement/pool aggregates', async () => {
    tx.call.create.mockRejectedValueOnce(p2002());
    await svc.applyBlock(
      tx as never,
      block,
      [
        {
          eventName: 'CallSettled',
          ...meta(0),
          callId: '0xc',
          slug: SLUG,
          agent: AGENT,
          status: SettlementStatus.Settled,
          premium: 1000n,
          refund: 0n,
          actualRefund: 0n,
          rootHash: '0xrh',
        },
      ],
      emptyCtx(),
    );
    expect(tx.agent.update).not.toHaveBeenCalled();
    expect(tx.settlement.upsert).not.toHaveBeenCalled();
    // no pool delta written for the slug
    expect(tx.poolState.upsert).not.toHaveBeenCalled();
    // cursor still advances
    expect(tx.indexerCursor.upsert).toHaveBeenCalled();
  });

  it('pool delta = Σpremium − ΣpaidOut − ΣactualRefund per slug', async () => {
    const ctx = emptyCtx();
    ctx.feeRecipients.set(SLUG, [{ address: AGENT, kind: 0, bps: 3000 }]);
    await svc.applyBlock(
      tx as never,
      block,
      [
        {
          eventName: 'CallSettled',
          ...meta(0),
          callId: '0xc',
          slug: SLUG,
          agent: AGENT,
          status: SettlementStatus.Settled,
          premium: 1000n,
          refund: 0n,
          actualRefund: 0n,
          rootHash: '0xrh',
        },
        {
          eventName: 'RecipientPaid',
          ...meta(1),
          slug: SLUG,
          recipient: AGENT,
          amount: 300n,
        },
      ],
      ctx,
    );
    const poolUpdate = tx.poolState.upsert.mock.calls.find(
      (c) => c[0].where.endpointSlug === SLUG,
    )![0];
    expect(poolUpdate.update.currentBalanceWei).toEqual({ increment: 700n });
    expect(poolUpdate.update.totalPremiumsWei).toEqual({ increment: 1000n });
    expect(poolUpdate.update.totalFeesPaidWei).toEqual({ increment: 300n });
    // structural kind: recipient == treasury → kind 0
    expect(tx.settlementRecipientShare.create.mock.calls[0][0].data.recipientKind).toBe(0);
  });

  it('RecipientPaid to a non-treasury address is tagged Affiliate', async () => {
    const ctx = emptyCtx();
    ctx.feeRecipients.set(SLUG, [
      { address: '0x9999999999999999999999999999999999999999', kind: 0, bps: 1000 },
    ]);
    await svc.applyBlock(
      tx as never,
      block,
      [{ eventName: 'RecipientPaid', ...meta(0), slug: SLUG, recipient: AGENT, amount: 50n }],
      ctx,
    );
    expect(tx.settlementRecipientShare.create.mock.calls[0][0].data.recipientKind).toBe(1);
    expect(tx.recipientEarnings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          endpointSlug_recipientAddress: {
            endpointSlug: SLUG,
            recipientAddress: AGENT,
          },
        },
      }),
    );
  });

  it('RecipientPaid replay (P2002) skips earnings + pool delta', async () => {
    tx.settlementRecipientShare.create.mockRejectedValueOnce(p2002());
    await svc.applyBlock(
      tx as never,
      block,
      [{ eventName: 'RecipientPaid', ...meta(0), slug: SLUG, recipient: AGENT, amount: 50n }],
      emptyCtx(),
    );
    expect(tx.recipientEarnings.upsert).not.toHaveBeenCalled();
    expect(tx.poolState.upsert).not.toHaveBeenCalled();
  });

  it('ProtocolPaused flips the in-memory flag, no DB write', async () => {
    expect(svc.protocolPaused).toBe(false);
    await svc.applyBlock(
      tx as never,
      block,
      [{ eventName: 'ProtocolPaused', ...meta(0), paused: true }],
      emptyCtx(),
    );
    expect(svc.protocolPaused).toBe(true);
  });
});
