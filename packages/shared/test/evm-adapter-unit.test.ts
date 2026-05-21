/**
 * EvmAdapter unit tests — mocked viem clients (WP-MN-04 T2).
 *
 * Uses vi.mock to stub createPublicClient and createWalletClient so no live
 * RPC calls are made. Each test injects fresh stub behavior via the mock
 * factory or explicit per-call overrides.
 *
 * Coverage targets (10 tests):
 *  1. submitSettleBatch throws when no signer configured
 *  2. submitSettleBatch wait-loop returns 'settled' when depth >= finalityBlocks
 *  3. submitSettleBatch wait-loop throws timeout when depth never reaches finality
 *  4. submitSettleBatch falls back to legacy gasPrice when estimateFeesPerGas rejects
 *  5. submitSettleBatch throws on reverted receipt
 *  6. readEndpointConfigs returns empty array when no EndpointRegistered logs
 *  7. readEndpointConfigs projects multicall results into snapshot shape
 *  8. checkAgentEligibility returns insufficient_balance when balance < required
 *  9. checkAgentEligibility returns insufficient_allowance when balance OK but allowance < required
 * 10. checkAgentEligibility returns eligible:true when both balance and allowance OK
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// Mock viem BEFORE importing EvmAdapter so the module sees the mocked exports.
// We mock at the module level; individual tests override method return values
// on the publicClient / walletClient instances captured below.

const mockReadContract = vi.fn();
const mockGetContractEvents = vi.fn();
const mockMulticall = vi.fn();
const mockGetBlockNumber = vi.fn();
const mockGetTransactionReceipt = vi.fn();
const mockEstimateFeesPerGas = vi.fn();
const mockGetGasPrice = vi.fn();
const mockEstimateGas = vi.fn();
const mockSendTransaction = vi.fn();
const mockGetBlock = vi.fn();

const MOCK_ACCOUNT = { address: "0xSettlerSignerAddress1234567890123456789012" as `0x${string}` };

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
      getContractEvents: mockGetContractEvents,
      multicall: mockMulticall,
      getBlockNumber: mockGetBlockNumber,
      getTransactionReceipt: mockGetTransactionReceipt,
      estimateFeesPerGas: mockEstimateFeesPerGas,
      getGasPrice: mockGetGasPrice,
      estimateGas: mockEstimateGas,
      getBlock: mockGetBlock,
    })),
    createWalletClient: vi.fn(() => ({
      account: MOCK_ACCOUNT,
      sendTransaction: mockSendTransaction,
    })),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => MOCK_ACCOUNT),
}));

import { EvmAdapter, type EvmAdapterOptions } from "../src/adapters/evm";
import { getChain } from "../src";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const descriptor = getChain("arc-testnet");

const BASE_OPTS: EvmAdapterOptions = {
  descriptor,
  rpcUrl: "http://localhost:8545",
  finalityBlocks: 2,
  blockTimeMs: 100, // fast for tests
  deploymentBlock: 0n,
};

const SIGNER_OPTS: EvmAdapterOptions = {
  ...BASE_OPTS,
  signer: { privateKey: "0xdeadbeef" as `0x${string}` },
};

// callId must be 0x + 32 hex chars (16 bytes) — matches asBytes16 validation in encode.ts
const SETTLE_CALL_ID = "0x00000000000000000000000000000001";

const SETTLE_INPUT = {
  slug: "helius",
  signer: null,
  events: [
    {
      callId: SETTLE_CALL_ID,
      agent: "0xA000000000000000000000000000000000000001",
      premiumBaseUnits: 1000n,
      outcome: "ok" as const,
      feeRecipientCountHint: 1,
      latencyMs: 200,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvmAdapter unit tests (WP-MN-04 T2)", () => {

  // 1. submitSettleBatch throws when no signer
  it("submitSettleBatch throws clear error when no signer set", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);
    await expect(adapter.submitSettleBatch(SETTLE_INPUT)).rejects.toThrow(
      /no signer configured/,
    );
  });

  // 2. submitSettleBatch wait-loop returns settled when depth >= finalityBlocks
  it("submitSettleBatch returns settled perEvent when finality depth reached on first poll", async () => {
    const adapter = new EvmAdapter(SIGNER_OPTS);

    mockEstimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 100n,
    });
    mockEstimateGas.mockResolvedValue(100000n);
    mockSendTransaction.mockResolvedValue("0xTxHash1234567890abcdef" as `0x${string}`);

    // Receipt: block 10, confirmed
    mockGetTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 10n,
    });
    // Current block: 12 -> depth = 12 - 10 + 1 = 3 >= finalityBlocks(2)
    mockGetBlockNumber.mockResolvedValue(12n);

    const result = await adapter.submitSettleBatch(SETTLE_INPUT);

    expect(result.txId).toBe("0xTxHash1234567890abcdef");
    expect(result.perEvent).toHaveLength(1);
    expect(result.perEvent[0].status).toBe("settled");
    expect(result.perEvent[0].callId).toBe(SETTLE_CALL_ID);
  });

  // 3. submitSettleBatch wait-loop throws timeout when depth never reaches finality
  it("submitSettleBatch throws timeout when finality depth never reached", async () => {
    // finalityBlocks=2, blockTimeMs=1, timeout = 2*1*3 = 6ms — very short for test speed
    const adapter = new EvmAdapter({
      ...SIGNER_OPTS,
      finalityBlocks: 2,
      blockTimeMs: 1,
    });

    mockEstimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 100n,
    });
    mockEstimateGas.mockResolvedValue(100000n);
    mockSendTransaction.mockResolvedValue("0xTxHashTimeout" as `0x${string}`);

    // Receipt found but block never advances — depth always 1 < finalityBlocks(2)
    mockGetTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 10n,
    });
    // Current block stays at 10 -> depth = 10 - 10 + 1 = 1 < 2
    mockGetBlockNumber.mockResolvedValue(10n);

    await expect(adapter.submitSettleBatch(SETTLE_INPUT)).rejects.toThrow(
      /finality timeout/,
    );
  });

  // 4. submitSettleBatch falls back to legacy gasPrice when estimateFeesPerGas rejects
  it("submitSettleBatch uses legacy gasPrice when estimateFeesPerGas rejects", async () => {
    const adapter = new EvmAdapter(SIGNER_OPTS);

    mockEstimateFeesPerGas.mockRejectedValue(new Error("EIP-1559 not supported"));
    mockGetGasPrice.mockResolvedValue(2000n);
    mockEstimateGas.mockResolvedValue(80000n);
    mockSendTransaction.mockResolvedValue("0xLegacyTxHash" as `0x${string}`);

    mockGetTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 5n,
    });
    mockGetBlockNumber.mockResolvedValue(8n); // depth = 8 - 5 + 1 = 4 >= 2

    const result = await adapter.submitSettleBatch(SETTLE_INPUT);
    expect(result.txId).toBe("0xLegacyTxHash");

    // Verify sendTransaction was called with gasPrice (legacy) not maxFeePerGas
    const sendArgs = (mockSendTransaction as Mock).mock.calls[0][0];
    expect(sendArgs).toHaveProperty("gasPrice");
    expect(sendArgs).not.toHaveProperty("maxFeePerGas");
    // gasPrice should be 2000 * 120 / 100 = 2400
    expect(sendArgs.gasPrice).toBe(2400n);
  });

  // 5. submitSettleBatch throws on reverted receipt
  it("submitSettleBatch throws when receipt.status === 'reverted'", async () => {
    const adapter = new EvmAdapter(SIGNER_OPTS);

    mockEstimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 100n,
    });
    mockEstimateGas.mockResolvedValue(100000n);
    mockSendTransaction.mockResolvedValue("0xRevertedTxHash" as `0x${string}`);

    mockGetTransactionReceipt.mockResolvedValue({
      status: "reverted",
      blockNumber: 7n,
    });

    // Minor A: assert the txHash is in the error message so operators grepping
    // a reverted-tx log can locate the offending hash directly.
    await expect(adapter.submitSettleBatch(SETTLE_INPUT)).rejects.toThrow(
      /reverted on-chain/,
    );
    await expect(adapter.submitSettleBatch(SETTLE_INPUT)).rejects.toThrow(
      /0xRevertedTxHash/,
    );
  });

  // 6. readEndpointConfigs returns empty array when no EndpointRegistered logs
  it("readEndpointConfigs returns empty array when no EndpointRegistered logs", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);

    mockReadContract.mockResolvedValue("0xAuthorityAddress");
    mockGetBlock.mockResolvedValue({ number: 0n });
    mockGetContractEvents.mockResolvedValue([]);

    const result = await adapter.readEndpointConfigs();
    expect(result).toEqual([]);
  });

  // 7. readEndpointConfigs projects multicall results into snapshot shape
  it("readEndpointConfigs projects multicall results correctly (authority, paused, feeRecipients, maxTotalFeeBps)", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);

    const AUTHORITY = "0xAuthorityAddr000000000000000000000000001";
    mockReadContract.mockResolvedValue(AUTHORITY);
    mockGetBlock.mockResolvedValue({ number: 0n });

    const SLUG_HEX = "0x68656c6975730000000000000000000000000000000000000000000000000000".slice(0, 34) as `0x${string}`;
    mockGetContractEvents.mockResolvedValue([
      {
        args: { slug: SLUG_HEX },
      },
    ]);

    const mockConfig = {
      paused: false,
      flatPremium: 100n,
      percentBps: 50,
      slaLatencyMs: 3000,
      imputedCost: 0n,
      exposureCapPerHour: 10000n,
      totalCalls: 5n,
      totalBreaches: 1n,
      totalPremiums: 500n,
      totalRefunds: 100n,
      currentPeriodStart: 0n,
      currentPeriodRefunds: 0n,
      lastUpdated: 0n,
      feeRecipientCount: 2,
      feeRecipients: [
        { kind: 0, destination: "0xTreasuryAddr000000000000000000000000001" as `0x${string}`, bps: 300 },
        { kind: 1, destination: "0xAffiliateAddr00000000000000000000000001" as `0x${string}`, bps: 200 },
      ],
    };

    mockMulticall.mockResolvedValue([mockConfig]);

    const results = await adapter.readEndpointConfigs();

    expect(results).toHaveLength(1);
    const snap = results[0];
    expect(snap.slug).toBe(SLUG_HEX.toLowerCase());
    expect(snap.authority).toBe(AUTHORITY);
    expect(snap.paused).toBe(false);
    // maxTotalFeeBps = sum of bps = 300 + 200 = 500
    expect(snap.maxTotalFeeBps).toBe(500);
    expect(snap.feeRecipients).toHaveLength(2);
    expect(snap.feeRecipients[0]).toEqual({
      recipient: "0xTreasuryAddr000000000000000000000000001",
      bps: 300,
      kind: 0,
    });
    expect(snap.feeRecipients[1]).toEqual({
      recipient: "0xAffiliateAddr00000000000000000000000001",
      bps: 200,
      kind: 1,
    });
    expect(snap.raw).toBe(mockConfig);
  });

  // 8. checkAgentEligibility returns insufficient_balance
  it("checkAgentEligibility returns insufficient_balance when balance < required", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);

    // multicall returns [balance, allowance]
    mockMulticall.mockResolvedValue([50n, 1000n]);

    const result = await adapter.checkAgentEligibility(
      "0xA000000000000000000000000000000000000001",
      100n,
    );

    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("insufficient_balance");
      expect(result.balance).toBe(50n);
      expect(result.allowance).toBe(1000n);
    }
  });

  // 9. checkAgentEligibility returns insufficient_allowance
  it("checkAgentEligibility returns insufficient_allowance when balance OK but allowance < required", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);

    mockMulticall.mockResolvedValue([1000n, 50n]);

    const result = await adapter.checkAgentEligibility(
      "0xA000000000000000000000000000000000000001",
      100n,
    );

    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("insufficient_allowance");
      expect(result.balance).toBe(1000n);
      expect(result.allowance).toBe(50n);
    }
  });

  // 10. checkAgentEligibility returns eligible:true when both OK
  it("checkAgentEligibility returns eligible:true when balance and allowance >= required", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);

    mockMulticall.mockResolvedValue([5000n, 3000n]);

    const result = await adapter.checkAgentEligibility(
      "0xA000000000000000000000000000000000000001",
      100n,
    );

    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.balance).toBe(5000n);
      expect(result.allowance).toBe(3000n);
    }
  });

  // 12. Hotfix regression: readEndpointConfigs must paginate eth_getLogs
  //     when (finalized - deploymentBlock) exceeds Arc Testnet's 10k-block
  //     cap. Asserts the loop runs N chunks rather than a single oversized
  //     query (the bug surfaced post-merge against live Arc Testnet RPC).
  it("readEndpointConfigs chunks getContractEvents into <=10k-block windows", async () => {
    const adapter = new EvmAdapter({
      ...BASE_OPTS,
      deploymentBlock: 0n,
    });

    mockReadContract.mockResolvedValue("0xAuthorityAddress");
    // finalized far past deploymentBlock → forces ~3 chunks at 9500/chunk
    mockGetBlock.mockResolvedValue({ number: 25_000n });
    mockGetContractEvents.mockResolvedValue([]);

    await adapter.readEndpointConfigs();

    // Expect 3 chunks: [0, 9499], [9500, 18999], [19000, 25000]
    expect(mockGetContractEvents).toHaveBeenCalledTimes(3);
    const calls = mockGetContractEvents.mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ fromBlock: 0n, toBlock: 9_499n });
    expect(calls[1]?.[0]).toMatchObject({ fromBlock: 9_500n, toBlock: 18_999n });
    expect(calls[2]?.[0]).toMatchObject({ fromBlock: 19_000n, toBlock: 25_000n });
  });

  // 11. Minor B: eligibility boundary — exact-equality case
  it("checkAgentEligibility returns eligible when balance === requiredBaseUnits exactly", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);

    // balance and allowance exactly equal to the requirement — the `<` checks
    // in the impl must NOT reject at the boundary.
    mockMulticall.mockResolvedValue([100n, 100n]);

    const result = await adapter.checkAgentEligibility(
      "0xA000000000000000000000000000000000000001",
      100n,
    );

    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.balance).toBe(100n);
      expect(result.allowance).toBe(100n);
    }
  });
});
