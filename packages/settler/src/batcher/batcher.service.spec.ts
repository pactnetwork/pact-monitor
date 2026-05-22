import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatcherService, MAX_BATCH_SIZE, SettleBatch } from "./batcher.service";
import { SettleMessage } from "../consumer/consumer.service";

function makeMessage(n: number, premiumLamports = "1000"): SettleMessage {
  return {
    id: String(n),
    data: { n, premiumLamports, callId: `call-${n}`, outcome: "success" },
    ack: vi.fn(),
    nack: vi.fn(),
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

  it("flushes after 5s timer when below MAX_BATCH_SIZE", async () => {
    // Push fewer than MAX_BATCH_SIZE so the size trigger doesn't fire — only
    // the timer can flush.
    for (let i = 0; i < MAX_BATCH_SIZE - 1; i++) {
      service.push(makeMessage(i));
    }

    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].messages).toHaveLength(MAX_BATCH_SIZE - 1);
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

  it("drops zero-premium messages: ack()s and skips pending", async () => {
    const msg = makeMessage(1, "0");
    service.push(msg);

    expect(service.pendingCount).toBe(0);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nack).not.toHaveBeenCalled();

    // Confirm no flush is scheduled — advancing time produces no batch.
    await vi.advanceTimersByTimeAsync(5000);
    expect(flushed).toHaveLength(0);
  });
});

// Multi-EVM WP T2: the flush loop must dispatch per-(network,slug) groups
// CONCURRENTLY so one slow/hung chain's finality wait does not head-of-line-
// block sibling groups, and a rejecting group must not take down its siblings
// (each group nacks its own batch inside the pipeline). Real timers — these
// assert dispatch behavior, not the 5s schedule.
describe("BatcherService — concurrent cross-group flush (multi-evm WP T2)", () => {
  function netMessage(network: string, slug: string, n: number): SettleMessage {
    return {
      id: String(n),
      data: {
        network,
        endpointSlug: slug,
        premiumLamports: "1000",
        callId: `call-${n}`,
        outcome: "ok",
      },
      ack: vi.fn(),
      nack: vi.fn(),
    };
  }

  it("dispatches groups concurrently: a hung group does not block siblings", async () => {
    const service = new BatcherService();
    const invoked: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    service.setFlushCallback(async (batch) => {
      const net = (batch.messages[0].data as Record<string, unknown>)
        .network as string;
      invoked.push(net);
      if (net === "arc-testnet") await aGate; // hang group A indefinitely
    });

    // Group A (arc-testnet) is pushed FIRST so the serial loop would reach it
    // before group B and block; the partition preserves insertion order.
    service.push(netMessage("arc-testnet", "helius", 1));
    service.push(netMessage("evm-test-2", "helius", 2));

    const flushP = service.flush();
    await Promise.resolve();
    await Promise.resolve();

    // Serial loop: B is never invoked while A hangs. Concurrent: B is invoked.
    expect(invoked).toContain("evm-test-2");

    releaseA();
    await flushP;
  });

  it("isolates a rejecting group: siblings still complete and flush resolves", async () => {
    const service = new BatcherService();
    const completed: string[] = [];
    service.setFlushCallback(async (batch) => {
      const net = (batch.messages[0].data as Record<string, unknown>)
        .network as string;
      if (net === "arc-testnet") throw new Error("group A boom");
      completed.push(net);
    });

    service.push(netMessage("arc-testnet", "helius", 1));
    service.push(netMessage("evm-test-2", "helius", 2));

    // A rejecting group must not reject the whole flush (it is surfaced, and the
    // pipeline nacks that group's own batch); the sibling must still complete.
    await expect(service.flush()).resolves.toBeUndefined();
    expect(completed).toContain("evm-test-2");
  });
});
