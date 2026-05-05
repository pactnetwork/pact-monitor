import { describe, test, expect, vi } from "vitest";
import { PubSubEventPublisher, type SettleEvent } from "../src/lib/events.js";

const sampleEvent: SettleEvent = {
  call_id: "test-id",
  agent_wallet: "wallet123",
  slug: "helius",
  outcome: "ok",
  breach: false,
  premium_lamports: "500",
  refund_lamports: "0",
  latency_ms: 120,
  timestamp: new Date().toISOString(),
};

describe("PubSubEventPublisher", () => {
  test("calls topic.publishMessage with event JSON", async () => {
    const mockTopic = { publishMessage: vi.fn().mockResolvedValue("msg-id") };
    const pub = new PubSubEventPublisher(mockTopic);
    await pub.publish(sampleEvent);
    expect(mockTopic.publishMessage).toHaveBeenCalledWith({ json: sampleEvent });
  });

  test("does not throw on publish error", async () => {
    const mockTopic = { publishMessage: vi.fn().mockRejectedValue(new Error("pubsub down")) };
    const pub = new PubSubEventPublisher(mockTopic);
    await expect(pub.publish(sampleEvent)).resolves.toBeUndefined();
  });
});
