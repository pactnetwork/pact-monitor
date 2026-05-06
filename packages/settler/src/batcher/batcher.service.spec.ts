import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatcherService, MAX_BATCH_SIZE, SettleBatch } from "./batcher.service";
import { SettleMessage } from "../consumer/consumer.service";

function makeMessage(n: number): SettleMessage {
  return {
    id: String(n),
    data: { n },
    raw: { ack: vi.fn(), nack: vi.fn() } as unknown as import("@google-cloud/pubsub").Message,
  };
}

describe("BatcherService", () => {
  let service: BatcherService;
  let flushed: SettleBatch[];

  beforeEach(() => {
    vi.useFakeTimers();
    service = new BatcherService();
    flushed = [];
    service.setFlushCallback(async (batch) => {
      flushed.push(batch);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flush below MAX_BATCH_SIZE messages", async () => {
    for (let i = 0; i < MAX_BATCH_SIZE - 1; i++) {
      service.push(makeMessage(i));
    }
    // Do NOT advance time — 5s has not passed, MAX_BATCH_SIZE-th message has not arrived
    await Promise.resolve();
    expect(flushed).toHaveLength(0);
    expect(service.pendingCount).toBe(MAX_BATCH_SIZE - 1);
  });

  it("flushes when MAX_BATCH_SIZE-th message arrives (size-based)", async () => {
    for (let i = 0; i < MAX_BATCH_SIZE; i++) {
      service.push(makeMessage(i));
    }
    // Flush is called synchronously via void this.flush()
    await Promise.resolve();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].messages).toHaveLength(MAX_BATCH_SIZE);
    expect(service.pendingCount).toBe(0);
  });

  it("flushes after 5s timer with fewer than 50 messages", async () => {
    service.push(makeMessage(1));
    service.push(makeMessage(2));
    service.push(makeMessage(3));

    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].messages).toHaveLength(3);
  });

  it("timer is cancelled after size-based flush", async () => {
    for (let i = 0; i < MAX_BATCH_SIZE; i++) {
      service.push(makeMessage(i));
    }
    await Promise.resolve();
    flushed.length = 0;

    // Advance 5s — no second flush should happen
    await vi.advanceTimersByTimeAsync(5000);
    expect(flushed).toHaveLength(0);
  });

  it("flush does nothing when queue is empty", async () => {
    await service.flush();
    expect(flushed).toHaveLength(0);
  });
});
