import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { IndexerPusherService } from "./indexer-pusher.service";
import { SettleBatch } from "../batcher/batcher.service";
import { SettleMessage } from "../consumer/consumer.service";

vi.mock("axios");

function makeConfig(): ConfigService {
  return {
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (k === "INDEXER_URL") return "http://indexer.local";
      if (k === "INDEXER_PUSH_SECRET") return "secret123";
      return "";
    }),
  } as unknown as ConfigService;
}

function makeBatch(count = 2): SettleBatch {
  const messages: SettleMessage[] = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    data: {
      callId: `call-${i}`,
      agentPubkey: "AgentPub1111111111111111111111111111111111111",
      endpointSlug: "helius",
      premiumLamports: "1000",
      refundLamports: "0",
      latencyMs: 80,
      breach: false,
      ts: new Date().toISOString(),
    },
    raw: { ack: vi.fn(), nack: vi.fn() } as unknown as import("@google-cloud/pubsub").Message,
  }));
  return { messages };
}

describe("IndexerPusherService", () => {
  let service: IndexerPusherService;
  let mockedPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const axios = await import("axios");
    mockedPost = vi.mocked(axios.default.post);
    mockedPost.mockReset();
    service = new IndexerPusherService(makeConfig());
  });

  it("posts to INDEXER_URL/events with bearer token on success", async () => {
    mockedPost.mockResolvedValueOnce({ status: 200 });
    await service.push("sig_abc", makeBatch(3));

    expect(mockedPost).toHaveBeenCalledOnce();
    const [url, body, config] = mockedPost.mock.calls[0];
    expect(url).toBe("http://indexer.local/events");
    expect((body as Record<string, unknown>)["signature"]).toBe("sig_abc");
    expect((body as Record<string, unknown>)["batchSize"]).toBe(3);
    expect(config?.headers?.["Authorization"]).toBe("Bearer secret123");
  });

  it("retries on failure and succeeds on second attempt", async () => {
    mockedPost
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ status: 200 });
    await service.push("sig_retry", makeBatch());
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("logs failure but does not throw after 3 failed attempts", async () => {
    mockedPost.mockRejectedValue(new Error("network down"));
    await expect(service.push("sig_fail", makeBatch())).resolves.toBeUndefined();
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });
});
