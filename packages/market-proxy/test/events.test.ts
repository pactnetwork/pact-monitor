// Events integration test — verifies wrap's PubSubEventSink wires up to a
// stub topic publisher. The proxy uses createPubSubSink in production; in
// tests we exercise the underlying PubSubEventSink directly (the
// createPubSubSink factory does a require("@google-cloud/pubsub") which
// pulls in grpc — out of scope for unit tests).

import { describe, test, expect, vi } from "vitest";
import {
  PubSubEventSink,
  type SettlementEvent,
} from "@pact-network/wrap";

const sampleEvent: SettlementEvent = {
  callId: "test-id",
  agentPubkey: "wallet123",
  endpointSlug: "helius",
  outcome: "ok",
  premiumLamports: "500",
  refundLamports: "0",
  latencyMs: 120,
  ts: new Date().toISOString(),
};

describe("PubSubEventSink (from @pact-network/wrap)", () => {
  test("calls topic.publishMessage with event JSON", async () => {
    const mockTopic = { publishMessage: vi.fn().mockResolvedValue("msg-id") };
    const sink = new PubSubEventSink({ topic: mockTopic });
    await sink.publish(sampleEvent);
    expect(mockTopic.publishMessage).toHaveBeenCalledWith({ json: sampleEvent });
  });

  test("does not throw on publish error (errors swallowed via onError)", async () => {
    const mockTopic = {
      publishMessage: vi.fn().mockRejectedValue(new Error("pubsub down")),
    };
    const onError = vi.fn();
    const sink = new PubSubEventSink({ topic: mockTopic, onError });
    await expect(sink.publish(sampleEvent)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
