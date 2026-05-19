import { describe, it, expect, vi } from "vitest";
import {
  MemoryEventSink,
  HttpEventSink,
  PubSubEventSink,
  RedisStreamsEventSink,
  type PubSubTopicPublisher,
  type RedisStreamPublisher,
} from "../eventSink";
import type { SettlementEvent } from "../types";

const sampleEvent: SettlementEvent = {
  callId: "call-1",
  agentPubkey: "Wallet111",
  endpointSlug: "helius",
  premiumLamports: "1000",
  refundLamports: "0",
  latencyMs: 120,
  outcome: "ok",
  ts: "2026-05-05T00:00:00.000Z",
};

describe("MemoryEventSink", () => {
  it("appends events", async () => {
    const sink = new MemoryEventSink();
    await sink.publish(sampleEvent);
    await sink.publish({ ...sampleEvent, callId: "call-2" });
    expect(sink.events).toHaveLength(2);
    expect(sink.events[0].callId).toBe("call-1");
    expect(sink.events[1].callId).toBe("call-2");
  });

  it("reset clears events", async () => {
    const sink = new MemoryEventSink();
    await sink.publish(sampleEvent);
    sink.reset();
    expect(sink.events).toHaveLength(0);
  });
});

describe("HttpEventSink", () => {
  it("POSTs JSON with content-type header", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 200 }));
    const sink = new HttpEventSink({ url: "https://x.test/ingest", fetchImpl: fetchSpy });
    await sink.publish(sampleEvent);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://x.test/ingest");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual(sampleEvent);
  });

  it("sets bearer when secret is provided", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 200 }));
    const sink = new HttpEventSink({
      url: "https://x.test/ingest",
      secret: "shhh",
      fetchImpl: fetchSpy,
    });
    await sink.publish(sampleEvent);
    expect(fetchSpy.mock.calls[0][1].headers.authorization).toBe("Bearer shhh");
  });

  it("swallows fetch rejection and reports via onError", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const sink = new HttpEventSink({
      url: "https://x.test/ingest",
      fetchImpl: fetchSpy,
      onError,
    });
    await expect(sink.publish(sampleEvent)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("boom");
  });

  it("reports non-2xx as error but does not throw", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    const onError = vi.fn();
    const sink = new HttpEventSink({
      url: "https://x.test/ingest",
      fetchImpl: fetchSpy,
      onError,
    });
    await expect(sink.publish(sampleEvent)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain("500");
  });

  it("default onError logs to console.warn (smoke)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn().mockRejectedValue(new Error("boom"));
    const sink = new HttpEventSink({
      url: "https://x.test/ingest",
      fetchImpl: fetchSpy,
    });
    await sink.publish(sampleEvent);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("PubSubEventSink", () => {
  it("publishes via topic.publishMessage with the event as json", async () => {
    const publishMessage = vi.fn().mockResolvedValue("msg-123");
    const topic: PubSubTopicPublisher = { publishMessage };
    const sink = new PubSubEventSink({ topic });
    await sink.publish(sampleEvent);
    expect(publishMessage).toHaveBeenCalledWith({ json: sampleEvent });
  });

  it("swallows publish failures and reports via onError", async () => {
    const publishMessage = vi.fn().mockRejectedValue(new Error("pubsub down"));
    const onError = vi.fn();
    const sink = new PubSubEventSink({
      topic: { publishMessage },
      onError,
    });
    await expect(sink.publish(sampleEvent)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("default onError logs to console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const publishMessage = vi.fn().mockRejectedValue(new Error("x"));
    const sink = new PubSubEventSink({ topic: { publishMessage } });
    await sink.publish(sampleEvent);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("RedisStreamsEventSink", () => {
  it("publishes via publisher.publish with default stream name", async () => {
    const publish = vi.fn().mockResolvedValue("1700000000-0");
    const publisher: RedisStreamPublisher = { publish };
    const sink = new RedisStreamsEventSink({ publisher });
    await sink.publish(sampleEvent);
    expect(publish).toHaveBeenCalledWith("pact-settle-events", sampleEvent);
  });

  it("honors a custom stream name", async () => {
    const publish = vi.fn().mockResolvedValue("1700000000-0");
    const publisher: RedisStreamPublisher = { publish };
    const sink = new RedisStreamsEventSink({
      publisher,
      stream: "custom-stream-name",
    });
    await sink.publish(sampleEvent);
    expect(publish).toHaveBeenCalledWith("custom-stream-name", sampleEvent);
  });

  it("swallows publish failures and reports via onError", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("redis down"));
    const onError = vi.fn();
    const sink = new RedisStreamsEventSink({
      publisher: { publish },
      onError,
    });
    await expect(sink.publish(sampleEvent)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("redis down");
  });

  it("default onError logs to console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const publish = vi.fn().mockRejectedValue(new Error("x"));
    const sink = new RedisStreamsEventSink({ publisher: { publish } });
    await sink.publish(sampleEvent);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
