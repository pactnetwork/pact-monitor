import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { IndexerPusherService } from "./indexer-pusher.service";
import { SettleBatch } from "../batcher/batcher.service";
import { SettleMessage } from "../consumer/consumer.service";
import {
  RecipientShare,
  SettlementOutcome,
} from "../submitter/submitter.service";
import { FeeRecipientKind } from "@pact-network/protocol-v1-client";

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
      callId: `0000000000000000000000000000000${i}`,
      agentPubkey: "AgentPub1111111111111111111111111111111111111",
      endpointSlug: "helius",
      premiumLamports: "1000",
      refundLamports: "0",
      latencyMs: 80,
      outcome: "ok",
      ts: new Date().toISOString(),
    },
    raw: { ack: vi.fn(), nack: vi.fn() } as unknown as import("@google-cloud/pubsub").Message,
  }));
  return { messages };
}

function makeOutcome(signature: string, batch: SettleBatch): SettlementOutcome {
  // One Treasury share per message at 10% — mirrors the V1 default template.
  const perEventShares: RecipientShare[][] = batch.messages.map(() => [
    {
      kind: FeeRecipientKind.Treasury,
      pubkey: "TreasuryVault11111111111111111111111111111111",
      amountLamports: 100n,
    },
  ]);
  return { signature, perEventShares };
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
    const batch = makeBatch(3);
    await service.push(makeOutcome("sig_abc", batch), batch);

    expect(mockedPost).toHaveBeenCalledOnce();
    const [url, body, config] = mockedPost.mock.calls[0];
    expect(url).toBe("http://indexer.local/events");
    expect((body as Record<string, unknown>)["signature"]).toBe("sig_abc");
    expect((body as Record<string, unknown>)["batchSize"]).toBe(3);
    expect(config?.headers?.["Authorization"]).toBe("Bearer secret123");
  });

  it("includes per-recipient shares in each call entry", async () => {
    mockedPost.mockResolvedValueOnce({ status: 200 });
    const batch = makeBatch(2);
    await service.push(makeOutcome("sig_xyz", batch), batch);

    const body = mockedPost.mock.calls[0][1] as Record<string, unknown>;
    const calls = body["calls"] as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const shares = c["shares"] as Array<Record<string, unknown>>;
      expect(shares).toHaveLength(1);
      expect(shares[0]["kind"]).toBe(FeeRecipientKind.Treasury);
      expect(shares[0]["amountLamports"]).toBe("100");
      expect(c["outcome"]).toBe("ok");
    }
  });

  it("retries on failure and succeeds on second attempt", async () => {
    mockedPost
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ status: 200 });
    const batch = makeBatch();
    await service.push(makeOutcome("sig_retry", batch), batch);
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("logs failure but does not throw after 3 failed attempts", async () => {
    mockedPost.mockRejectedValue(new Error("network down"));
    const batch = makeBatch();
    await expect(
      service.push(makeOutcome("sig_fail", batch), batch),
    ).resolves.toBeUndefined();
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("propagates non-ok outcomes from the wire payload", async () => {
    mockedPost.mockResolvedValueOnce({ status: 200 });
    const batch = makeBatch(1);
    (batch.messages[0].data as Record<string, unknown>)["outcome"] = "latency_breach";
    await service.push(makeOutcome("sig_breach", batch), batch);
    const body = mockedPost.mock.calls[0][1] as Record<string, unknown>;
    const calls = body["calls"] as Array<Record<string, unknown>>;
    expect(calls[0]["outcome"]).toBe("latency_breach");
  });
});
