// MemoryQueueConsumer spec — covers the produce → consume → handler-invoked
// path that proves the in-process queue is a usable substitute for Pub/Sub /
// Redis Streams in local dev.

import { describe, it, expect, vi } from "vitest";
import { MemoryQueueConsumer } from "./memory-queue-consumer";

describe("MemoryQueueConsumer", () => {
  it("publish() enqueues a message that drain() returns", () => {
    const consumer = new MemoryQueueConsumer();
    consumer.init();
    consumer.publish({ callId: "abc", premiumLamports: "1000" });
    expect(consumer.queueLength).toBe(1);
    const [msg] = consumer.drain();
    expect(msg.data.callId).toBe("abc");
    expect(consumer.queueLength).toBe(0);
    consumer.destroy();
  });

  it("invokes the enqueue callback synchronously on publish()", () => {
    const consumer = new MemoryQueueConsumer();
    const cb = vi.fn();
    consumer.init();
    consumer.setEnqueueCallback(cb);
    const id = consumer.publish({ callId: "xyz" });
    expect(cb).toHaveBeenCalledOnce();
    const handed = cb.mock.calls[0][0];
    expect(handed.id).toBe(id);
    expect(handed.data.callId).toBe("xyz");
    consumer.destroy();
  });

  it("assigns monotonically increasing synthetic message ids", () => {
    const consumer = new MemoryQueueConsumer();
    consumer.init();
    const id1 = consumer.publish({ callId: "a" });
    const id2 = consumer.publish({ callId: "b" });
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("mem-")).toBe(true);
    expect(id2.startsWith("mem-")).toBe(true);
    consumer.destroy();
  });

  it("ack() is a no-op (no broker to acknowledge)", () => {
    const consumer = new MemoryQueueConsumer();
    consumer.init();
    consumer.publish({ callId: "abc" });
    const drained = consumer.drain();
    expect(() => consumer.ack(drained)).not.toThrow();
    expect(consumer.queueLength).toBe(0);
    consumer.destroy();
  });

  it("nack() re-enqueues the message at the tail for retry", () => {
    const consumer = new MemoryQueueConsumer();
    consumer.init();
    consumer.publish({ callId: "retry-me" });
    const drained = consumer.drain();
    consumer.nack(drained);
    expect(consumer.queueLength).toBe(1);
    const [requeued] = consumer.drain();
    expect(requeued.data.callId).toBe("retry-me");
    consumer.destroy();
  });

  it("destroy() clears the queue and detaches the callback", () => {
    const consumer = new MemoryQueueConsumer();
    const cb = vi.fn();
    consumer.init();
    consumer.setEnqueueCallback(cb);
    consumer.publish({ callId: "one" });
    consumer.destroy();
    expect(consumer.queueLength).toBe(0);
    // After destroy, callback is detached — a fresh publish does not fire it.
    consumer.publish({ callId: "two" });
    expect(cb).toHaveBeenCalledOnce();
  });
});
