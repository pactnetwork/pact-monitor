// RedisStreamsQueueConsumer spec — uses an in-process stub that intercepts
// the `call(<COMMAND>, ...args)` escape hatch the consumer uses to bypass
// ioredis' typed overloads. No real Redis required. Covers:
//   - XGROUP CREATE is called idempotently (BUSYGROUP swallowed)
//   - XREADGROUP results are decoded and enqueued
//   - ack() invokes XACK
//   - nack() below MAX_DELIVERY_ATTEMPTS leaves entry pending
//   - nack() at MAX_DELIVERY_ATTEMPTS moves to DLQ + XACKs
//   - Malformed entries are dropped (XACKed) and not enqueued

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RedisStreamsQueueConsumer,
  MAX_DELIVERY_ATTEMPTS,
} from "./redis-streams-queue-consumer";

interface CallRecord {
  command: string;
  args: (string | number)[];
}

interface StubClient {
  call: ReturnType<typeof vi.fn>;
  /** All recorded calls in order, for assertion convenience. */
  records: CallRecord[];
  /** Programmable responses, indexed by command name. */
  responses: Record<string, unknown[]>;
}

function makeStub(opts: {
  initialDeliveryCount?: number;
  busyGroup?: boolean;
  firstReadResult?: unknown;
  autoClaimResult?: unknown;
} = {}): StubClient {
  const records: CallRecord[] = [];
  const responses: Record<string, unknown[]> = {
    XGROUP: opts.busyGroup
      ? [() => { throw new Error("BUSYGROUP Consumer Group name already exists"); }]
      : ["OK"],
    XREADGROUP: [opts.firstReadResult ?? null],
    XACK: [1, 1, 1, 1],
    XADD: ["1700000000-0"],
    XPENDING: [[["1-0", "settler-1", 1000, opts.initialDeliveryCount ?? 1]]],
    XAUTOCLAIM: [opts.autoClaimResult ?? ["0-0", [], []]],
  };

  let xreadgroupCallCount = 0;
  const call = vi.fn(async (command: string, ...args: (string | number)[]) => {
    // Don't record XREADGROUP after the first programmed result — the
    // poll loop calls it indefinitely in tests and would balloon memory.
    // Tests don't assert on subsequent XREADGROUP calls anyway.
    if (command === "XREADGROUP") {
      xreadgroupCallCount += 1;
      if (xreadgroupCallCount === 1) {
        records.push({ command, args });
        return responses.XREADGROUP[0];
      }
      // Subsequent reads: yield briefly and return null forever
      await new Promise((r) => setTimeout(r, 1));
      return null;
    }
    records.push({ command, args });
    const queue = responses[command];
    if (!queue || queue.length === 0) return undefined;
    const next = queue.length === 1 ? queue[0] : queue.shift();
    if (typeof next === "function") return (next as () => unknown)();
    return next;
  });

  return { call, records, responses };
}

function makeConsumer(stub: StubClient) {
  return new RedisStreamsQueueConsumer(stub as unknown as import("ioredis").Redis, {
    stream: "pact-settle-events",
    group: "settler",
    consumerName: "settler-test",
  });
}

describe("RedisStreamsQueueConsumer — init", () => {
  it("calls XGROUP CREATE with MKSTREAM and starts the poll loop", async () => {
    const stub = makeStub();
    const consumer = makeConsumer(stub);
    await consumer.init();
    const xgroupCall = stub.records.find((r) => r.command === "XGROUP");
    expect(xgroupCall).toBeDefined();
    expect(xgroupCall?.args).toEqual([
      "CREATE",
      "pact-settle-events",
      "settler",
      "$",
      "MKSTREAM",
    ]);
    await consumer.destroy();
  });

  it("ignores BUSYGROUP error (consumer group already exists)", async () => {
    const stub = makeStub({ busyGroup: true });
    const consumer = makeConsumer(stub);
    await expect(consumer.init()).resolves.toBeUndefined();
    await consumer.destroy();
  });

  it("recovers stale pending entries via XAUTOCLAIM at boot", async () => {
    const stub = makeStub({
      autoClaimResult: [
        "0-0",
        [["5-0", ["event", JSON.stringify({ callId: "stale-1" })]]],
        [],
      ],
    });
    const consumer = makeConsumer(stub);
    await consumer.init();
    await new Promise((r) => setTimeout(r, 10));
    expect(consumer.queueLength).toBe(1);
    await consumer.destroy();
  });
});

describe("RedisStreamsQueueConsumer — message flow", () => {
  let stub: StubClient;
  let consumer: RedisStreamsQueueConsumer;

  beforeEach(() => {
    stub = makeStub({
      firstReadResult: [
        [
          "pact-settle-events",
          [
            ["1-0", ["event", JSON.stringify({ callId: "abc", premiumLamports: "1000" })]],
            ["2-0", ["event", JSON.stringify({ callId: "def", premiumLamports: "500" })]],
          ],
        ],
      ],
    });
    consumer = makeConsumer(stub);
  });

  afterEach(async () => {
    await consumer.destroy();
  });

  it("decodes well-formed XREADGROUP entries and enqueues them", async () => {
    await consumer.init();
    await new Promise((r) => setTimeout(r, 10));

    expect(consumer.queueLength).toBe(2);
    const drained = consumer.drain();
    expect(drained[0].data.callId).toBe("abc");
    expect(drained[1].data.callId).toBe("def");
  });

  it("ack() calls XACK on the underlying entry", async () => {
    await consumer.init();
    await new Promise((r) => setTimeout(r, 10));

    const [msg] = consumer.drain();
    msg.ack();
    await new Promise((r) => setTimeout(r, 5));

    const xackCalls = stub.records.filter(
      (r) => r.command === "XACK" && r.args[2] === "1-0",
    );
    expect(xackCalls).toHaveLength(1);
  });
});

describe("RedisStreamsQueueConsumer — malformed entries", () => {
  it("XACKs and drops entries missing the 'event' field", async () => {
    const stub = makeStub({
      firstReadResult: [["pact-settle-events", [["3-0", ["other", "value"]]]]],
    });
    const consumer = makeConsumer(stub);
    await consumer.init();
    await new Promise((r) => setTimeout(r, 10));

    expect(consumer.queueLength).toBe(0);
    const xack = stub.records.find(
      (r) => r.command === "XACK" && r.args[2] === "3-0",
    );
    expect(xack).toBeDefined();
    await consumer.destroy();
  });

  it("XACKs and drops entries with unparseable JSON", async () => {
    const stub = makeStub({
      firstReadResult: [
        ["pact-settle-events", [["4-0", ["event", "this is not json"]]]],
      ],
    });
    const consumer = makeConsumer(stub);
    await consumer.init();
    await new Promise((r) => setTimeout(r, 10));

    expect(consumer.queueLength).toBe(0);
    const xack = stub.records.find(
      (r) => r.command === "XACK" && r.args[2] === "4-0",
    );
    expect(xack).toBeDefined();
    await consumer.destroy();
  });
});

describe("RedisStreamsQueueConsumer — nack + DLQ", () => {
  it("nack below MAX_DELIVERY_ATTEMPTS leaves entry pending (no DLQ XADD)", async () => {
    const stub = makeStub({
      initialDeliveryCount: 3,
      firstReadResult: [
        ["pact-settle-events", [["6-0", ["event", JSON.stringify({ callId: "retry" })]]]],
      ],
    });
    const consumer = makeConsumer(stub);
    await consumer.init();
    await new Promise((r) => setTimeout(r, 10));

    const [msg] = consumer.drain();
    msg.nack();
    await new Promise((r) => setTimeout(r, 10));

    // No XADD to DLQ
    const dlqAdds = stub.records.filter(
      (r) => r.command === "XADD" && r.args[0] === "pact-settle-events-dlq",
    );
    expect(dlqAdds).toHaveLength(0);
    // No XACK on the main stream
    const mainAcks = stub.records.filter(
      (r) =>
        r.command === "XACK" &&
        r.args[0] === "pact-settle-events" &&
        r.args[2] === "6-0",
    );
    expect(mainAcks).toHaveLength(0);

    await consumer.destroy();
  });

  it("nack at MAX_DELIVERY_ATTEMPTS moves to DLQ and XACKs", async () => {
    const stub = makeStub({
      initialDeliveryCount: MAX_DELIVERY_ATTEMPTS,
      firstReadResult: [
        ["pact-settle-events", [["7-0", ["event", JSON.stringify({ callId: "poison" })]]]],
      ],
    });
    const consumer = makeConsumer(stub);
    await consumer.init();
    await new Promise((r) => setTimeout(r, 10));

    const [msg] = consumer.drain();
    msg.nack();
    await new Promise((r) => setTimeout(r, 10));

    const dlqAdd = stub.records.find(
      (r) => r.command === "XADD" && r.args[0] === "pact-settle-events-dlq",
    );
    expect(dlqAdd).toBeDefined();
    expect(dlqAdd?.args).toContain(JSON.stringify({ callId: "poison" }));
    expect(dlqAdd?.args).toContain("7-0"); // origId field value

    const mainAck = stub.records.find(
      (r) =>
        r.command === "XACK" &&
        r.args[0] === "pact-settle-events" &&
        r.args[2] === "7-0",
    );
    expect(mainAck).toBeDefined();

    await consumer.destroy();
  });
});
