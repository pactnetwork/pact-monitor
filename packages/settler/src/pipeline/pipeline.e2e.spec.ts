import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PubSub } from "@google-cloud/pubsub";
import { EventEmitter } from "events";

import { BatcherService } from "../batcher/batcher.service";
import { ConsumerService } from "../consumer/consumer.service";
import { SubmitterService } from "../submitter/submitter.service";
import { IndexerPusherService } from "../indexer/indexer-pusher.service";
import { PipelineService } from "./pipeline.service";
import { SecretLoaderService } from "../config/secret-loader.service";
import { FeeRecipientKind } from "@pact-network/protocol-v1-client";

// ---------------------------------------------------------------------------
// Pipeline-level e2e: wire ConsumerService → BatcherService → SubmitterService
// → IndexerPusherService end-to-end with all chain plumbing stubbed. Verifies
// post-Step-C event shape (canonical wrap-library SettlementEvent) propagates
// through the new SettlementOutcome path into the indexer push.
// ---------------------------------------------------------------------------

const sendAndConfirmMock = vi.fn();
const getAccountInfoMock = vi.fn();
const buildSettleBatchIxMock = vi.fn();
const decodeEndpointConfigMock = vi.fn();
const decodeCoveragePoolMock = vi.fn();
const decodeTreasuryMock = vi.fn();

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    sendAndConfirmTransaction: (...args: unknown[]) => sendAndConfirmMock(...args),
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: getAccountInfoMock,
    })),
    Transaction: vi.fn().mockImplementation(() => ({
      add: vi.fn().mockReturnThis(),
    })),
  };
});

vi.mock("@pact-network/protocol-v1-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@pact-network/protocol-v1-client")
  >();
  return {
    ...actual,
    buildSettleBatchIx: (...args: unknown[]) => buildSettleBatchIxMock(...args),
    decodeEndpointConfig: (...args: unknown[]) => decodeEndpointConfigMock(...args),
    decodeCoveragePool: (...args: unknown[]) => decodeCoveragePoolMock(...args),
    decodeTreasury: (...args: unknown[]) => decodeTreasuryMock(...args),
  };
});

vi.mock("axios");

function makeEventData(i: number, agentPubkey: string) {
  return {
    callId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    agentPubkey,
    endpointSlug: "helius",
    premiumLamports: "1000",
    refundLamports: "0",
    latencyMs: 100,
    outcome: "ok",
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
  let treasuryVault: PublicKey;
  let heliusPoolVault: PublicKey;

  beforeEach(async () => {
    vi.useFakeTimers();
    sendAndConfirmMock.mockReset();
    getAccountInfoMock.mockReset();
    buildSettleBatchIxMock.mockReset();
    decodeEndpointConfigMock.mockReset();
    decodeCoveragePoolMock.mockReset();
    decodeTreasuryMock.mockReset();

    sendAndConfirmMock.mockResolvedValue("e2e-sig-001");
    buildSettleBatchIxMock.mockReturnValue({
      keys: [],
      programId: PublicKey.default,
      data: Buffer.from([10]),
    });
    treasuryVault = Keypair.generate().publicKey;
    heliusPoolVault = Keypair.generate().publicKey;

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
      get: vi.fn().mockImplementation((k: string) => {
        if (k === "PROGRAM_ID") return "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";
        if (k === "USDC_MINT") return "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
        return undefined;
      }),
    } as unknown as ConfigService;

    // Wire chain stubs so the SubmitterService's onModuleInit + endpoint
    // load + treasury load resolve cleanly for slug "helius".
    decodeTreasuryMock.mockReturnValue({
      bump: 254,
      authority: PublicKey.default.toBase58(),
      usdcVault: treasuryVault.toBase58(),
      setAt: 0n,
    });
    decodeEndpointConfigMock.mockReturnValue({
      bump: 254,
      paused: false,
      slug: new TextEncoder().encode("helius".padEnd(16, "\0")).slice(0, 16),
      flatPremiumLamports: 1000n,
      percentBps: 0,
      slaLatencyMs: 200,
      imputedCostLamports: 5000n,
      exposureCapPerHourLamports: 1_000_000n,
      currentPeriodStart: 0n,
      currentPeriodRefunds: 0n,
      totalCalls: 0n,
      totalBreaches: 0n,
      totalPremiums: 0n,
      totalRefunds: 0n,
      lastUpdated: 0n,
      coveragePool: PublicKey.default.toBase58(),
      feeRecipientCount: 1,
      feeRecipients: [
        {
          kind: FeeRecipientKind.Treasury,
          destination: treasuryVault.toBase58(),
          bps: 1000,
        },
      ],
    });
    decodeCoveragePoolMock.mockReturnValue({
      bump: 254,
      authority: PublicKey.default.toBase58(),
      usdcMint: PublicKey.default.toBase58(),
      usdcVault: heliusPoolVault.toBase58(),
      endpointSlug: new Uint8Array(16),
      totalDeposits: 0n,
      totalPremiums: 0n,
      totalRefunds: 0n,
      currentBalance: 1_000_000_000n,
      createdAt: 0n,
    });
    getAccountInfoMock.mockResolvedValue({
      data: Buffer.from("any-mock-data"),
    });

    consumer = new ConsumerService(config, mockPubSub);
    batcher = new BatcherService();
    submitter = new SubmitterService(
      config,
      { keypair: devKeypair } as unknown as SecretLoaderService,
    );
    pusher = new IndexerPusherService(config);
    pipeline = new PipelineService(consumer, batcher, submitter, pusher);

    consumer.onModuleInit();
    await submitter.onModuleInit();
    pipeline.onModuleInit();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends 3 messages, all settled in one batch and indexer pushed", async () => {
    const axios = await import("axios");
    const postSpy = vi.mocked(axios.default.post);
    const agentPubkey = Keypair.generate().publicKey.toBase58();

    for (let i = 0; i < 3; i++) {
      const data = makeEventData(i, agentPubkey);
      subEmitter.emit("message", {
        id: String(i),
        data: Buffer.from(JSON.stringify(data)),
        ack: vi.fn(),
        nack: vi.fn(),
      });
    }

    // Advance 5s to trigger the timer-based flush.
    await vi.advanceTimersByTimeAsync(5000);
    // Let the async pipeline chain resolve.
    await vi.runAllTimersAsync();

    expect(postSpy).toHaveBeenCalledOnce();
    const [, body] = postSpy.mock.calls[0];
    expect((body as Record<string, unknown>)["batchSize"]).toBe(3);
    expect((body as Record<string, unknown>)["signature"]).toBe("e2e-sig-001");
    const calls = (body as Record<string, unknown>)["calls"] as Array<
      Record<string, unknown>
    >;
    expect(calls).toHaveLength(3);
    // Each call should carry the per-recipient share breakdown.
    for (const c of calls) {
      const shares = c["shares"] as Array<Record<string, unknown>>;
      expect(shares).toHaveLength(1);
      expect(shares[0]["kind"]).toBe(FeeRecipientKind.Treasury);
      // 1000 * 1000 / 10_000 = 100
      expect(shares[0]["amountLamports"]).toBe("100");
      expect(shares[0]["pubkey"]).toBe(treasuryVault.toBase58());
    }
  }, 15000);
});
