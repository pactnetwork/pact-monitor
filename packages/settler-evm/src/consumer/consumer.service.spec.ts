import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConsumerService } from './consumer.service';
import { PubSub } from '@google-cloud/pubsub';
import { EventEmitter } from 'events';

function makeConfig(): ConfigService {
  return {
    getOrThrow: vi.fn().mockImplementation((key: string) => {
      if (key === 'PUBSUB_PROJECT') return 'test-project';
      if (key === 'PUBSUB_SUBSCRIPTION') return 'test-sub';
      return '';
    }),
  } as unknown as ConfigService;
}

function makeMockMessage(data: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    data: Buffer.from(JSON.stringify(data)),
    ack: vi.fn(),
    nack: vi.fn(),
  };
}

describe('ConsumerService', () => {
  let service: ConsumerService;
  let subEmitter: EventEmitter;

  beforeEach(() => {
    subEmitter = new EventEmitter();
    const mockSub = {
      on: (e: string, cb: (...a: unknown[]) => void) => subEmitter.on(e, cb),
      removeAllListeners: vi.fn(),
      close: vi.fn(),
    };
    const mockPubSub = {
      subscription: vi.fn().mockReturnValue(mockSub),
    } as unknown as PubSub;
    service = new ConsumerService(makeConfig(), mockPubSub);
    service.onModuleInit();
  });

  it('calls enqueue callback for each received message', () => {
    const cb = vi.fn();
    service.setEnqueueCallback(cb);
    const msg = makeMockMessage({ callId: 'abc' });
    subEmitter.emit('message', msg);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toMatchObject({ id: msg.id });
  });

  it('queues messages and drain returns them all', () => {
    subEmitter.emit('message', makeMockMessage({ n: 1 }));
    subEmitter.emit('message', makeMockMessage({ n: 2 }));
    subEmitter.emit('message', makeMockMessage({ n: 3 }));
    const drained = service.drain();
    expect(drained).toHaveLength(3);
    expect(service.queueLength).toBe(0);
  });

  it('ack calls ack on the raw message', () => {
    const msg = makeMockMessage({ x: 1 });
    subEmitter.emit('message', msg);
    const [queued] = service.drain();
    service.ack([queued]);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('nack calls nack on the raw message', () => {
    const msg = makeMockMessage({ x: 1 });
    subEmitter.emit('message', msg);
    const [queued] = service.drain();
    service.nack([queued]);
    expect(msg.nack).toHaveBeenCalledOnce();
  });
});
