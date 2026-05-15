import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { AgentsController } from './agents.controller';
import { EndpointsController } from './endpoints.controller';
import type { PrismaService } from '../db/prisma.service';

const callRow = {
  callId: '0xc',
  agentAddress: '0xa',
  endpointSlug: '0xs',
  premiumWei: 1000n,
  refundWei: 0n,
  requestedRefundWei: 5n,
  latencyMs: null,
  breach: false,
  breachReason: null,
  status: 1,
  evidenceRootHash: '0xrh',
  source: null,
  ts: new Date(),
  settledAt: new Date(),
  txHash: '0xtx',
  blockNumber: 42n,
  logIndex: 3,
};

describe('CallsController', () => {
  it('serializes bigints to strings on the recent firehose', async () => {
    const prisma = {
      call: { findMany: vi.fn().mockResolvedValue([callRow]) },
    } as unknown as PrismaService;
    const out = await new CallsController(prisma).listRecent('5');
    expect(out[0]).toMatchObject({
      premiumWei: '1000',
      requestedRefundWei: '5',
      blockNumber: '42',
      latencyMs: null,
      status: 1,
    });
  });

  it('getCall joins recipient shares by call.txHash (re-keyed)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { recipientKind: 0, recipientAddress: '0xt', amountWei: 300n },
    ]);
    const prisma = {
      call: { findUnique: vi.fn().mockResolvedValue(callRow) },
      settlementRecipientShare: { findMany },
    } as unknown as PrismaService;
    const out = await new CallsController(prisma).getCall('0xc');
    expect(findMany).toHaveBeenCalledWith({ where: { settlementTx: '0xtx' } });
    expect(out.recipientShares).toEqual([
      { kind: 0, address: '0xt', amountWei: '300' },
    ]);
  });

  it('404s an unknown call', async () => {
    const prisma = {
      call: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    await expect(new CallsController(prisma).getCall('x')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('AgentsController', () => {
  it('clamps the limit to [1,200]', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { call: { findMany } } as unknown as PrismaService;
    await new AgentsController(prisma).getAgentCalls('0xa', '9999');
    expect(findMany.mock.calls[0][0].take).toBe(200);
  });
});

describe('EndpointsController', () => {
  it('populates feeRecipients from the FeeRecipient projection', async () => {
    const prisma = {
      endpoint: {
        findUnique: vi.fn().mockResolvedValue({
          slug: '0xs',
          agentTokenId: '1',
          flatPremiumWei: 10n,
          percentBps: 50,
          imputedCostWei: 2n,
          latencySloMs: 1000,
          exposureCapPerHourWei: 9n,
          paused: false,
          upstreamModel: null,
          upstreamProvider: null,
          upstreamEndpoint: null,
          displayName: null,
          registeredAt: new Date(),
          lastUpdated: new Date(),
          poolState: null,
        }),
      },
      feeRecipient: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { endpointSlug: '0xs', recipientAddress: '0xt', kind: 0, bps: 1000 },
          ]),
      },
    } as unknown as PrismaService;
    const out = await new EndpointsController(prisma).getEndpoint('0xs');
    expect(out.feeRecipients).toEqual([
      { address: '0xt', kind: 0, bps: 1000 },
    ]);
    expect(out.flatPremiumWei).toBe('10');
    expect(out.pool).toBeNull();
  });
});
