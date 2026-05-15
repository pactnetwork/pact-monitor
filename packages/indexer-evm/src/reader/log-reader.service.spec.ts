import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decodePactCoreEvent } = vi.hoisted(() => ({
  decodePactCoreEvent: vi.fn(),
}));
vi.mock('@pact-network/protocol-zerog-client', async (orig) => ({
  ...(await orig<typeof import('@pact-network/protocol-zerog-client')>()),
  decodePactCoreEvent,
}));

import { LogReaderService } from './log-reader.service';
import type { ReadClients } from '../chain/chain';
import type { PrismaService } from '../db/prisma.service';
import type { ProjectionService } from '../projection/projection.service';
import type { ConfigService } from '@nestjs/config';

function build() {
  const publicClient = {
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    getLogs: vi.fn().mockResolvedValue([]),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1_700_000_000n }),
  };
  const pactCore = {
    protocolPaused: vi.fn().mockResolvedValue(false),
    getFeeRecipients: vi.fn().mockResolvedValue([]),
    getEndpointConfig: vi.fn(),
  };
  const clients = { publicClient, pactCore } as unknown as ReadClients;
  const prisma = {
    indexerCursor: {
      upsert: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue({ lastBlock: 99n }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({})),
  } as unknown as PrismaService;
  const projection = {
    applyBlock: vi.fn().mockResolvedValue(undefined),
    setProtocolPaused: vi.fn(),
  } as unknown as ProjectionService;
  const cfg: Record<string, unknown> = {
    INDEXER_START_BLOCK: 50,
    POLL_INTERVAL_MS: 2000,
    LOG_RANGE: 500,
    ZEROG_CHAIN_ID: 16602,
    ZEROG_RPC_URL: 'https://evmrpc-testnet.0g.ai',
    ZEROG_STORAGE_INDEXER_URL: 'https://indexer-storage-testnet-turbo.0g.ai',
    PACT_CORE_ADDRESS: '0x1111111111111111111111111111111111111111',
  };
  const config = {
    getOrThrow: (k: string) => cfg[k],
  } as unknown as ConfigService;
  const svc = new LogReaderService(clients, prisma, projection, config);
  return { svc, publicClient, pactCore, prisma, projection };
}

describe('LogReaderService', () => {
  beforeEach(() => decodePactCoreEvent.mockReset());

  it('tick advances the cursor to page end even with zero logs', async () => {
    const { svc, prisma } = build();
    await svc.tick();
    expect(prisma.indexerCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastBlock: 100n }),
      }),
    );
    expect(svc.lastProcessed).toBe(100n);
  });

  it('groups logs by block, ascending, and runs one $transaction per block', async () => {
    const { svc, prisma, projection, publicClient } = build();
    publicClient.getLogs.mockResolvedValue([{ b: 2 }, { b: 1 }]);
    decodePactCoreEvent
      .mockReturnValueOnce({ eventName: 'ProtocolPaused', paused: true, blockNumber: 2n, logIndex: 0, txHash: '0x' })
      .mockReturnValueOnce({ eventName: 'ProtocolPaused', paused: false, blockNumber: 1n, logIndex: 0, txHash: '0x' });
    await svc.tick();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const order = (projection.applyBlock as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1].number,
    );
    expect(order).toEqual([1n, 2n]);
  });

  it('getLogsAdaptive bisects on a range-limit error', async () => {
    const { svc, publicClient } = build();
    publicClient.getLogs
      .mockRejectedValueOnce(new Error('query returned more than 10000 results'))
      .mockResolvedValueOnce([{ x: 1 }])
      .mockResolvedValueOnce([{ x: 2 }]);
    const out = await svc.getLogsAdaptive(1n, 100n);
    expect(out).toEqual([{ x: 1 }, { x: 2 }]);
    expect(publicClient.getLogs).toHaveBeenCalledTimes(3);
  });

  it('getLogsAdaptive rethrows when a single block still errors', async () => {
    const { svc, publicClient } = build();
    publicClient.getLogs.mockRejectedValue(new Error('range too large'));
    await expect(svc.getLogsAdaptive(7n, 7n)).rejects.toThrow(/range too large/);
  });

  it('beforeApplicationShutdown stops the loop and drains in-flight', async () => {
    const { svc } = build();
    await svc.beforeApplicationShutdown();
    // a subsequent tick must not process (stopped) — cursor read still ok,
    // but the while-loop guard `!this.stopped` exits immediately
    const spy = vi.spyOn(
      svc as unknown as { getLogsAdaptive: () => Promise<unknown[]> },
      'getLogsAdaptive',
    );
    await svc.tick();
    expect(spy).not.toHaveBeenCalled();
  });
});
