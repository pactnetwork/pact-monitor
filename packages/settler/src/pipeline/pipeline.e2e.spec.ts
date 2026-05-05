import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatcherService } from "../batcher/batcher.service";
import { ConsumerService } from "../consumer/consumer.service";
import { SubmitterService } from "../submitter/submitter.service";
import { IndexerPusherService } from "../indexer/indexer-pusher.service";
import { PipelineService } from "./pipeline.service";
import { ConfigService } from "@nestjs/config";
import { SecretLoaderService } from "../config/secret-loader.service";
import { Keypair } from "@solana/web3.js";
import { PubSub } from "@google-cloud/pubsub";
import { EventEmitter } from "events";

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    sendAndConfirmTransaction: vi.fn().mockResolvedValue("e2e-sig-001"),
    Connection: vi.fn().mockImplementation(() => ({})),
    Transaction: vi.fn().mockImplementation(() => ({ add: vi.fn().mockReturnThis() })),
  };
});

vi.mock("@pact-network/market-client", () => ({
  buildSettleBatch: vi.fn().mockReturnValue({ keys: [], data: Buffer.from([]) }),
  deriveSettlementAuthority: vi.fn().mockReturnValue([{ toBase58: () => "auth" }, 255]),
  deriveCoveragePool: vi.fn().mockReturnValue([{ toBase58: () => "pool" }, 255]),
  deriveCallRecord: vi.fn().mockReturnValue([{ toBase58: () => "call" }, 255]),
  deriveAgentWallet: vi.fn().mockReturnValue([{ toBase58: () => "wallet" }, 255]),
  slugBytes: vi.fn().mockReturnValue(new Uint8Array(16)),
}));

vi.mock("axios");

function makeEventData(i: number) {
  const pk = Keypair.generate().publicKey.toBase58();
  return {
    callId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    agentPubkey: pk,
    agentVault: pk,
    endpointPda: pk,
    endpointSlug: "helius",
    premiumLamports: "1000",
    refundLamports: "0",
    latencyMs: 100,
    breach: false,
    timestamp: Math.floor(Date.now() / 1000),
    ts: new Date().toISOString(),
  };
}

describe("Pipeline e2e", () => {
  let consumer: ConsumerService;
  let batcher: BatcherService;
  let submitter: SubmitterService;
  let pusher: IndexerPusherService;
  let pipeline: PipelineService;
  let subEmitter: EventEmitter;

  beforeEach(async () => {
    vi.useFakeTimers();

    const axios = await import("axios");
    vi.mocked(axios.default.post).mockResolvedValue({ status: 200 });

    subEmitter = new EventEmitter();
    const mockSub = {
      on: (e: string, cb: (...a: unknown[]) => void) => subEmitter.on(e, cb),
      removeAllListeners: vi.fn(),
      close: vi.fn(),
    };
    const mockPubSub = { subscription: vi.fn().mockReturnValue(mockSub) } as unknown as PubSub;

    const devKeypair = Keypair.generate();

    const config = {
      getOrThrow: vi.fn().mockImplementation((k: string) => {
        if (k === "PUBSUB_PROJECT") return "proj";
        if (k === "PUBSUB_SUBSCRIPTION") return "sub";
        if (k === "SOLANA_RPC_URL") return "https://api.devnet.solana.com";
        if (k === "INDEXER_URL") return "http://indexer.local";
        if (k === "INDEXER_PUSH_SECRET") return "secret";
        return "";
      }),
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    consumer = new ConsumerService(config, mockPubSub);
    batcher = new BatcherService();
    submitter = new SubmitterService(config, { keypair: devKeypair } as unknown as SecretLoaderService);
    pusher = new IndexerPusherService(config);
    pipeline = new PipelineService(consumer, batcher, submitter, pusher);

    consumer.onModuleInit();
    pipeline.onModuleInit();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends 5 messages, all settled in one batch and indexer pushed", async () => {
    const axios = await import("axios");
    const postSpy = vi.mocked(axios.default.post);

    for (let i = 0; i < 5; i++) {
      const data = makeEventData(i);
      subEmitter.emit("message", {
        id: String(i),
        data: Buffer.from(JSON.stringify(data)),
        ack: vi.fn(),
        nack: vi.fn(),
      });
    }

    // Advance 5s to trigger the timer-based flush
    await vi.advanceTimersByTimeAsync(5000);
    // Let the async pipeline chain resolve
    await vi.runAllTimersAsync();

    expect(postSpy).toHaveBeenCalledOnce();
    const [, body] = postSpy.mock.calls[0];
    expect((body as Record<string, unknown>)["batchSize"]).toBe(5);
    expect((body as Record<string, unknown>)["signature"]).toBe("e2e-sig-001");
  }, 15000);
});
