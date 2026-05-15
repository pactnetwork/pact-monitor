import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decodeContractError } = vi.hoisted(() => ({
  decodeContractError: vi.fn(),
}));
vi.mock('@pact-network/protocol-zerog-client', async (orig) => ({
  ...(await orig<typeof import('@pact-network/protocol-zerog-client')>()),
  decodeContractError,
}));

import { SettlementStatus } from '@pact-network/protocol-zerog-client';
import { SubmitterService } from './submitter.service';
import { SigningMutex } from '../chain/chain';
import type { SettleMessage } from '../consumer/consumer.service';
import type { SettleBatch } from '../batcher/batcher.service';

const VALID = {
  agentPubkey: '0x1111111111111111111111111111111111111111',
  endpointSlug: 'llama-3-8b',
  premiumLamports: '1000',
  refundLamports: '0',
  outcome: 'ok',
  ts: '2026-05-15T12:00:00.000Z',
  latencyMs: 100,
};

function m(callId: string): SettleMessage {
  return {
    id: crypto.randomUUID(),
    data: { ...VALID, callId },
    raw: { ack: vi.fn(), nack: vi.fn() },
  } as unknown as SettleMessage;
}
function batchOf(...ids: string[]): SettleBatch {
  return { messages: ids.map(m) };
}

describe('SubmitterService', () => {
  let svc: SubmitterService;
  let pact: { getCallStatus: ReturnType<typeof vi.fn>; settleBatch: ReturnType<typeof vi.fn> };
  let storage: { writeEvidence: ReturnType<typeof vi.fn> };
  let pub: {
    getBlock: ReturnType<typeof vi.fn>;
    simulateContract: ReturnType<typeof vi.fn>;
    waitForTransactionReceipt: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    recordOrphans: ReturnType<typeof vi.fn>;
    markSettled: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
  let batcher: { markSettled: ReturnType<typeof vi.fn> };
  const calls: string[] = [];

  beforeEach(() => {
    decodeContractError.mockReset();
    calls.length = 0;
    pact = {
      getCallStatus: vi.fn().mockResolvedValue(SettlementStatus.Unsettled),
      settleBatch: vi.fn(async () => {
        calls.push('settle');
        return '0xtx';
      }),
    };
    storage = {
      writeEvidence: vi.fn(async () => {
        calls.push('upload');
        return { rootHash: '0xrh', txHash: '0xs', txSeq: 1 };
      }),
    };
    pub = {
      getBlock: vi.fn().mockResolvedValue({ timestamp: 9_999_999_999n }),
      simulateContract: vi.fn().mockResolvedValue({}),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    };
    prisma = {
      recordOrphans: vi.fn(async () => calls.push('recordOrphans')),
      markSettled: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    batcher = { markSettled: vi.fn() };

    svc = new SubmitterService(
      {} as never,
      {} as never,
      prisma as never,
      batcher as never,
      new SigningMutex(),
    );
    Object.assign(svc as unknown as Record<string, unknown>, {
      pact,
      storage,
      publicClient: pub,
      account: '0x1111111111111111111111111111111111111111',
      pactAddress: '0x2222222222222222222222222222222222222222',
    });
  });

  it('happy path: orphan rows written BEFORE the settle tx, then ack', async () => {
    const r = await svc.submit(batchOf('a0000000-0000-0000-0000-000000000001'));
    expect(prisma.recordOrphans).toHaveBeenCalledOnce();
    // upload(s) + recordOrphans must precede settle
    expect(calls).toEqual(['upload', 'recordOrphans', 'settle']);
    expect(prisma.markSettled).toHaveBeenCalledOnce();
    expect(batcher.markSettled).toHaveBeenCalledOnce();
    expect(r.toAck).toHaveLength(1);
    expect(r.toNack).toHaveLength(0);
    expect(r.txHash).toBe('0xtx');
  });

  it('rootHash from storage is carried into the settled records', async () => {
    await svc.submit(batchOf('a0000000-0000-0000-0000-000000000001'));
    const records = pact.settleBatch.mock.calls[0][0];
    expect(records[0].rootHash).toBe('0xrh');
  });

  it('pre-filters an already-settled callId (DuplicateCallId prevention)', async () => {
    pact.getCallStatus
      .mockResolvedValueOnce(SettlementStatus.Settled) // first → already on-chain
      .mockResolvedValueOnce(SettlementStatus.Unsettled);
    const r = await svc.submit(
      batchOf(
        'a0000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000002',
      ),
    );
    expect(pact.settleBatch.mock.calls[0][0]).toHaveLength(1); // only unsettled
    expect(batcher.markSettled).toHaveBeenCalled();
    expect(r.toAck).toHaveLength(2); // pre-settled + freshly settled both ack
    expect(r.toNack).toHaveLength(0);
  });

  it('all already settled → no tx, all acked', async () => {
    pact.getCallStatus.mockResolvedValue(SettlementStatus.PoolDepleted);
    const r = await svc.submit(batchOf('a0000000-0000-0000-0000-000000000001'));
    expect(pact.settleBatch).not.toHaveBeenCalled();
    expect(r.toAck).toHaveLength(1);
  });

  it('DuplicateCallId at simulate → requery + reslice + succeed', async () => {
    pub.simulateContract
      .mockRejectedValueOnce(new Error('dup'))
      .mockResolvedValueOnce({});
    decodeContractError.mockReturnValueOnce({
      name: 'DuplicateCallId',
      message: '',
    });
    // after reslice the dup now reads as settled, the other is unsettled
    pact.getCallStatus
      .mockResolvedValueOnce(SettlementStatus.Unsettled)
      .mockResolvedValueOnce(SettlementStatus.Unsettled)
      .mockResolvedValueOnce(SettlementStatus.Settled)
      .mockResolvedValueOnce(SettlementStatus.Unsettled);
    const r = await svc.submit(
      batchOf(
        'a0000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000002',
      ),
    );
    expect(pub.simulateContract).toHaveBeenCalledTimes(2);
    expect(pact.settleBatch).toHaveBeenCalledOnce();
    expect(r.toNack).toHaveLength(0);
    expect(r.toAck.length).toBeGreaterThanOrEqual(2);
  });

  it('unrecoverable revert (ProtocolPaused) → no upload, nack all', async () => {
    pub.simulateContract.mockRejectedValue(new Error('paused'));
    decodeContractError.mockReturnValue({ name: 'ProtocolPaused', message: '' });
    const r = await svc.submit(batchOf('a0000000-0000-0000-0000-000000000001'));
    expect(storage.writeEvidence).not.toHaveBeenCalled();
    expect(prisma.recordOrphans).not.toHaveBeenCalled();
    expect(r.toNack).toHaveLength(1);
    expect(r.toAck).toHaveLength(0);
  });

  it('reverted receipt after a clean simulate → markFailed + nack', async () => {
    pub.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    const r = await svc.submit(batchOf('a0000000-0000-0000-0000-000000000001'));
    expect(prisma.recordOrphans).toHaveBeenCalledOnce();
    expect(prisma.markFailed).toHaveBeenCalledWith(
      expect.any(Array),
      'reverted_post_simulate',
    );
    expect(r.toNack).toHaveLength(1);
  });

  it('an unmappable message is acked+dropped, never poisons the batch', async () => {
    const bad = {
      id: 'x',
      data: { ...VALID, callId: 'not-a-uuid' },
      raw: { ack: vi.fn(), nack: vi.fn() },
    } as unknown as SettleMessage;
    const r = await svc.submit({ messages: [bad] });
    expect(r.toAck).toContain(bad);
    expect(r.toNack).toHaveLength(0);
    expect(pact.settleBatch).not.toHaveBeenCalled();
  });
});
