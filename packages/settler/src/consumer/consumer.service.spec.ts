// ConsumerService spec — exercises the NestJS facade against the
// PubSubQueueConsumer (mainnet default). Behavior is byte-identical to the
// pre-refactor ConsumerService spec; the only mechanical change is that
// the service now delegates to an injected QueueConsumer instead of owning
// the Pub/Sub Subscription directly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConsumerService, QUEUE_CONSUMER } from "./consumer.service";
import { PubSubQueueConsumer } from "./pubsub-queue-consumer";
import { PubSub } from "@google-cloud/pubsub";
import { EventEmitter } from "events";

function makeMockMessage(data: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    data: Buffer.from(JSON.stringify(data)),
    ack: vi.fn(),
    nack: vi.fn(),
  };
}

describe("ConsumerService (PubSub backend)", () => {
  let service: ConsumerService;
  let subEmitter: EventEmitter;

  beforeEach(async () => {
    subEmitter = new EventEmitter();
    const mockSub = {
      on: (e: string, cb: (...a: unknown[]) => void) => subEmitter.on(e, cb),
      removeAllListeners: vi.fn(),
      close: vi.fn(),
    };
    const mockPubSub = {
      subscription: vi.fn().mockReturnValue(mockSub),
    } as unknown as PubSub;

    const consumer = new PubSubQueueConsumer(mockPubSub, {
      projectId: "test-project",
      subscriptionName: "test-sub",
    });
    service = new ConsumerService(consumer);
    await service.onModuleInit();
  });

  it("calls enqueue callback for each received message", () => {
    const cb = vi.fn();
    service.setEnqueueCallback(cb);
    const msg = makeMockMessage({ callId: "abc" });
    subEmitter.emit("message", msg);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toMatchObject({ id: msg.id });
  });

  it("queues messages and drain returns them all", () => {
    subEmitter.emit("message", makeMockMessage({ n: 1 }));
    subEmitter.emit("message", makeMockMessage({ n: 2 }));
    subEmitter.emit("message", makeMockMessage({ n: 3 }));
    const drained = service.drain();
    expect(drained).toHaveLength(3);
    expect(service.queueLength).toBe(0);
  });

  it("ack delegates to the backend message's ack closure", () => {
    const msg = makeMockMessage({ x: 1 });
    subEmitter.emit("message", msg);
    const [queued] = service.drain();
    service.ack([queued]);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it("nack delegates to the backend message's nack closure", () => {
    const msg = makeMockMessage({ x: 1 });
    subEmitter.emit("message", msg);
    const [queued] = service.drain();
    service.nack([queued]);
    expect(msg.nack).toHaveBeenCalledOnce();
  });

  it("QUEUE_CONSUMER token is exported for DI use", () => {
    expect(typeof QUEUE_CONSUMER).toBe("symbol");
  });
});
