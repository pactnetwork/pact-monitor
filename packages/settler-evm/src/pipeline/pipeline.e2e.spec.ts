import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineService } from './pipeline.service';
import type { ConsumerService } from '../consumer/consumer.service';
import type { BatcherService, SettleBatch } from '../batcher/batcher.service';
import type { SubmitterService } from '../submitter/submitter.service';
import type { SettleMessage } from '../consumer/consumer.service';

function msg(id: string): SettleMessage {
  return { id, data: {}, raw: { ack: vi.fn(), nack: vi.fn() } } as unknown as SettleMessage;
}
const batch = (...ids: string[]): SettleBatch => ({ messages: ids.map(msg) });

describe('PipelineService (mocked e2e)', () => {
  let pipeline: PipelineService;
  let enqueueCb: (m: SettleMessage) => void;
  let flushCb: (b: SettleBatch) => Promise<void>;
  let consumer: { ack: ReturnType<typeof vi.fn>; nack: ReturnType<typeof vi.fn>; setEnqueueCallback: (c: never) => void; queueLength: number };
  let batcher: { setFlushCallback: (c: never) => void; push: ReturnType<typeof vi.fn>; flushNow: ReturnType<typeof vi.fn> };
  let submitter: { submit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    consumer = {
      ack: vi.fn(),
      nack: vi.fn(),
      queueLength: 0,
      setEnqueueCallback: (c: never) => {
        enqueueCb = c as unknown as typeof enqueueCb;
      },
    };
    batcher = {
      push: vi.fn(),
      flushNow: vi.fn().mockResolvedValue(undefined),
      setFlushCallback: (c: never) => {
        flushCb = c as unknown as typeof flushCb;
      },
    };
    submitter = { submit: vi.fn() };
    pipeline = new PipelineService(
      consumer as unknown as ConsumerService,
      batcher as unknown as BatcherService,
      submitter as unknown as SubmitterService,
    );
    pipeline.onModuleInit();
  });

  it('acks the settled messages and nacks the failed ones', async () => {
    const b = batch('a', 'b');
    submitter.submit.mockResolvedValue({
      toAck: [b.messages[0]],
      toNack: [b.messages[1]],
      txHash: '0xtx',
    });
    await flushCb(b);
    expect(consumer.ack).toHaveBeenCalledWith([b.messages[0]]);
    expect(consumer.nack).toHaveBeenCalledWith([b.messages[1]]);
  });

  it('processes batches strictly sequentially (no overlap)', async () => {
    const events: string[] = [];
    submitter.submit.mockImplementation(async (bb: SettleBatch) => {
      events.push(`start:${bb.messages[0].id}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end:${bb.messages[0].id}`);
      return { toAck: bb.messages, toNack: [] };
    });
    // fire two flushes without awaiting the first
    const p1 = flushCb(batch('1'));
    const p2 = flushCb(batch('2'));
    await Promise.all([p1, p2]);
    expect(events).toEqual([
      'start:1',
      'end:1',
      'start:2',
      'end:2',
    ]);
  });

  it('an unexpected submit throw nacks the whole batch', async () => {
    const b = batch('x');
    submitter.submit.mockRejectedValue(new Error('rpc exploded'));
    await flushCb(b);
    expect(consumer.nack).toHaveBeenCalledWith(b.messages);
  });

  it('drops new messages once shutting down, drains the tail', async () => {
    let resolveSubmit!: () => void;
    submitter.submit.mockImplementation(
      () =>
        new Promise((res) => {
          resolveSubmit = () => res({ toAck: [], toNack: [] });
        }),
    );
    const inflight = flushCb(batch('s1'));
    await vi.waitFor(() => expect(resolveSubmit).toBeTypeOf('function'));
    const destroy = pipeline.onModuleDestroy();
    // shuttingDown now true — enqueue must drop, not push
    enqueueCb(msg('late'));
    expect(batcher.push).not.toHaveBeenCalled();
    resolveSubmit();
    await inflight;
    await destroy;
    expect(batcher.flushNow).toHaveBeenCalledOnce();
  });

  it('lagMs is null until the first success then non-negative', async () => {
    expect(pipeline.lagMs).toBeNull();
    submitter.submit.mockResolvedValue({ toAck: [msg('a')], toNack: [] });
    await flushCb(batch('a'));
    expect(pipeline.lagMs).toBeGreaterThanOrEqual(0);
  });
});
