import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { encodeCallId } from '@pact-network/protocol-zerog-client';
import { BatcherService, FLUSH_INTERVAL_MS } from './batcher.service';
import type { SettleMessage } from '../consumer/consumer.service';

const VALID = {
  callId: '550e8400-e29b-41d4-a716-446655440000',
  agentPubkey: '0x1111111111111111111111111111111111111111',
  endpointSlug: 'llama-3-8b',
  premiumLamports: '1000',
  refundLamports: '0',
  outcome: 'ok',
  ts: '2026-05-15T12:00:00.000Z',
};

function msg(over: Record<string, unknown> = {}): SettleMessage {
  return {
    id: crypto.randomUUID(),
    data: { ...VALID, ...over },
    raw: { ack: vi.fn(), nack: vi.fn() },
  } as unknown as SettleMessage;
}

function batcher(maxBatchSize = 3): BatcherService {
  const config = {
    get: (k: string) => (k === 'MAX_BATCH_SIZE' ? maxBatchSize : undefined),
  } as unknown as ConfigService;
  return new BatcherService(config);
}

describe('BatcherService EVM guards', () => {
  it('flushes at MAX_BATCH_SIZE with only valid events', async () => {
    const b = batcher(3);
    const flush = vi.fn().mockResolvedValue(undefined);
    b.setFlushCallback(flush);
    const m1 = msg({ callId: crypto.randomUUID() });
    const m2 = msg({ callId: crypto.randomUUID() });
    const m3 = msg({ callId: crypto.randomUUID() });
    b.push(m1);
    b.push(m2);
    b.push(m3);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0][0].messages).toHaveLength(3);
    // accepted messages are NOT acked at the boundary
    expect((m1.raw.ack as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it.each([
    ['premium_too_small', { premiumLamports: '50' }],
    ['premium_too_small', { premiumLamports: '0' }],
    ['amount_overflow', { premiumLamports: (2n ** 96n).toString() }],
    ['malformed_amount', { premiumLamports: 'abc' }],
    ['invalid_slug', { endpointSlug: 'a'.repeat(17) }],
    ['invalid_slug', { endpointSlug: 'naïve' }],
    ['invalid_agent', { agentPubkey: 'So11111111111111111111111111111111111111112' }],
    ['invalid_agent', { agentPubkey: '0xnotanaddress' }],
    ['invalid_callid', { callId: 'not-a-uuid' }],
  ])('drops %s and acks the message', (reason, over) => {
    const b = batcher();
    const m = msg(over);
    b.push(m);
    expect(b.pendingCount).toBe(0);
    expect(m.raw.ack).toHaveBeenCalledOnce();
    expect(b.droppedCounts.get(reason as never)).toBe(1);
  });

  it('drops a callId already confirmed settled (cross-batch dedup)', () => {
    const b = batcher();
    const id = '550e8400-e29b-41d4-a716-446655440000';
    b.markSettled([encodeCallId(id)]);
    const m = msg({ callId: id });
    b.push(m);
    expect(b.pendingCount).toBe(0);
    expect(m.raw.ack).toHaveBeenCalledOnce();
    expect(b.droppedCounts.get('duplicate_settled')).toBe(1);
  });

  it('still accepts an unsettled callId (nack-retry not deduped)', () => {
    const b = batcher();
    b.markSettled([encodeCallId(crypto.randomUUID())]); // unrelated id
    const m = msg({ callId: crypto.randomUUID() });
    b.push(m);
    expect(b.pendingCount).toBe(1);
  });

  describe('flush timer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('flushes a partial batch after the idle interval', async () => {
      const b = batcher(10);
      const flush = vi.fn().mockResolvedValue(undefined);
      b.setFlushCallback(flush);
      b.push(msg({ callId: crypto.randomUUID() }));
      expect(flush).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      expect(flush).toHaveBeenCalledOnce();
      expect(flush.mock.calls[0][0].messages).toHaveLength(1);
    });
  });
});
