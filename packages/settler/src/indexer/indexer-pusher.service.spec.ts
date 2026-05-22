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

  it("throws IndexerPushError after 3 failed attempts (so PipelineService can nack)", async () => {
    mockedPost.mockRejectedValue(new Error("network down"));
    const batch = makeBatch();
    await expect(
      service.push(makeOutcome("sig_fail", batch), batch),
    ).rejects.toThrow(/indexer push failed permanently/);
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

  // Finding 5a — the pusher stamps a batch-level network so the indexer can
  // tag the Settlement / Endpoint-FK / PoolState / recipient-share aggregate
  // rows (keyed on network) instead of falling back to its solana-devnet
  // default.
  it("stamps batch-level network from an arc-testnet batch", async () => {
    mockedPost.mockResolvedValueOnce({ status: 200 });
    const batch = makeBatch(2);
    for (const m of batch.messages) {
      (m.data as Record<string, unknown>)["network"] = "arc-testnet";
    }
    await service.push(makeOutcome("sig_arc", batch), batch);
    const body = mockedPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body["network"]).toBe("arc-testnet");
  });

  // Regression: an unstamped (legacy Solana) batch still resolves to
  // solana-devnet — Solana ingest must keep landing under solana-devnet.
  it("defaults batch-level network to solana-devnet for unstamped batches", async () => {
    mockedPost.mockResolvedValueOnce({ status: 200 });
    const batch = makeBatch(2); // messages carry no `network` field
    await service.push(makeOutcome("sig_sol", batch), batch);
    const body = mockedPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body["network"]).toBe("solana-devnet");
  });

  // Single-network invariant: the batcher partitions by network before flush,
  // so a mixed-network batch reaching the pusher is a regression — fail loud.
  it("throws on a mixed-network batch (single-network invariant)", async () => {
    const batch = makeBatch(2);
    (batch.messages[0].data as Record<string, unknown>)["network"] = "arc-testnet";
    (batch.messages[1].data as Record<string, unknown>)["network"] = "solana-devnet";
    await expect(
      service.push(makeOutcome("sig_mixed", batch), batch),
    ).rejects.toThrow(/mixed-network batch/);
  });

  // Single-slug invariant (review #226 F5): the batcher now partitions by
  // (network, slug) before flush, but the submitter routes the whole adapter
  // batch by the first message's slug. A mixed-slug batch reaching the pusher
  // means a direct caller or a batcher regression — fail loud rather than
  // mis-indexing the batch under one slug's endpoint config.
  it("throws on a mixed-slug batch (single-slug invariant)", async () => {
    const batch = makeBatch(2);
    (batch.messages[0].data as Record<string, unknown>)["endpointSlug"] = "helius";
    (batch.messages[1].data as Record<string, unknown>)["endpointSlug"] = "birdeye";
    await expect(
      service.push(makeOutcome("sig_mixed_slug", batch), batch),
    ).rejects.toThrow(/mixed-slug batch/);
  });
});
