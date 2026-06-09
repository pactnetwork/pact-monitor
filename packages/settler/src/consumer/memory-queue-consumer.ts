// In-process QueueConsumer. For local/offline dev only.
//
// Lets the settler boot without GCP Pub/Sub or a Redis instance. The consumer
// exposes a `publish()` method so an in-process producer (a dev fixture, a
// test, a sibling NestJS service in the same process) can hand SettlementEvent
// payloads to the settler pipeline without going through an external broker.
//
// Semantics intentionally mirror the other backends:
//   - publish(data)            ≈ Pub/Sub message arrival / XADD
//   - drain() / setEnqueueCallback wire into the batcher exactly like pubsub
//   - ack() / nack()           — no-op for ack; nack re-enqueues so the
//                                handler-invoked path can be exercised
//
// Not safe for production: there is no durability, no retry policy, and no
// cross-process delivery. The env validator restricts this backend to
// QUEUE_BACKEND=memory which mainnet's ENV_PROD never sets.

import { Logger } from "@nestjs/common";
import type { QueueConsumer, SettleMessage } from "./queue-consumer.interface";

export class MemoryQueueConsumer implements QueueConsumer {
  private readonly logger = new Logger(MemoryQueueConsumer.name);
  private readonly queue: SettleMessage[] = [];
  private onEnqueue: ((msg: SettleMessage) => void) | null = null;
  private seq = 0;

  init(): void {
    this.logger.log(
      "MemoryQueueConsumer active — in-process queue, no durability. Local dev only.",
    );
  }

  destroy(): void {
    this.queue.length = 0;
    this.onEnqueue = null;
  }

  setEnqueueCallback(cb: (msg: SettleMessage) => void): void {
    this.onEnqueue = cb;
  }

  drain(): SettleMessage[] {
    return this.queue.splice(0, this.queue.length);
  }

  ack(_messages: SettleMessage[]): void {
    // No-op: in-memory delivery is at-most-once and there is no broker to
    // acknowledge. Each SettleMessage's per-message ack() is also a no-op.
  }

  nack(messages: SettleMessage[]): void {
    // Re-enqueue at the tail so the handler can pick it up again. Useful for
    // exercising retry-shaped tests; no delivery-attempt cap.
    for (const m of messages) this.enqueue(m.data);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Publish a SettlementEvent payload into the in-process queue. Returns the
   * synthetic message id so callers can correlate. Mirrors the side effect
   * that Pub/Sub's on("message") and Redis Streams' XREADGROUP poll cause.
   */
  publish(data: Record<string, unknown>): string {
    return this.enqueue(data);
  }

  private enqueue(data: Record<string, unknown>): string {
    this.seq += 1;
    const id = `mem-${this.seq}`;
    const message: SettleMessage = {
      id,
      data,
      ack: () => {},
      nack: () => {
        this.enqueue(data);
      },
    };
    this.queue.push(message);
    this.onEnqueue?.(message);
    return id;
  }
}
