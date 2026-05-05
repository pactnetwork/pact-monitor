import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { SubmitterService, BatchSubmitError } from "./submitter.service";
import { SecretLoaderService } from "../config/secret-loader.service";
import { Keypair } from "@solana/web3.js";
import { SettleBatch } from "../batcher/batcher.service";
import { SettleMessage } from "../consumer/consumer.service";

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    sendAndConfirmTransaction: vi.fn(),
    Connection: vi.fn().mockImplementation(() => ({})),
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

function makeConfig(): ConfigService {
  return {
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (k === "SOLANA_RPC_URL") return "https://api.devnet.solana.com";
      return "";
    }),
    get: vi.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
}

function makeTestBatch(count = 1): SettleBatch {
  const devKey = Keypair.generate();
  const messages: SettleMessage[] = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    data: {
      callId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      agentPubkey: devKey.publicKey.toBase58(),
      endpointSlug: "helius",
      agentVault: devKey.publicKey.toBase58(),
      endpointPda: devKey.publicKey.toBase58(),
      premiumLamports: "1000",
      refundLamports: "0",
      latencyMs: 120,
      breach: false,
      timestamp: Math.floor(Date.now() / 1000),
    },
    raw: { ack: vi.fn(), nack: vi.fn() } as unknown as import("@google-cloud/pubsub").Message,
  }));
  return { messages };
}

describe("SubmitterService", () => {
  let service: SubmitterService;
  let sendAndConfirm: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { sendAndConfirmTransaction } = await import("@solana/web3.js");
    sendAndConfirm = sendAndConfirmTransaction as ReturnType<typeof vi.fn>;
    sendAndConfirm.mockReset();

    const devKeypair = Keypair.generate();
    service = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService
    );
  });

  it("returns signature on happy path", async () => {
    sendAndConfirm.mockResolvedValueOnce("sig123");
    const sig = await service.submit(makeTestBatch());
    expect(sig).toBe("sig123");
    expect(sendAndConfirm).toHaveBeenCalledOnce();
  });

  it("retries on first failure and succeeds on second", async () => {
    sendAndConfirm
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("sig456");
    const sig = await service.submit(makeTestBatch());
    expect(sig).toBe("sig456");
    expect(sendAndConfirm).toHaveBeenCalledTimes(2);
  });

  it("throws BatchSubmitError after 3 consecutive failures", async () => {
    sendAndConfirm.mockRejectedValue(new Error("rpc down"));
    await expect(service.submit(makeTestBatch())).rejects.toThrow(BatchSubmitError);
    expect(sendAndConfirm).toHaveBeenCalledTimes(3);
  });
});
