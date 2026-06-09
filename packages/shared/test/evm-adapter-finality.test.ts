/**
 * EvmAdapter finalityBlockTag tests (WP-BASE T0).
 *
 * Verifies that the EvmAdapter uses the configured finalityBlockTag ("safe" or
 * "finalized") in its getBlock calls instead of the hardcoded "finalized".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

const descriptor = getChain("arc-testnet");

const BASE_OPTS: EvmAdapterOptions = {
  descriptor,
  rpcUrl: "http://localhost:8545",
  finalityBlocks: 2,
  blockTimeMs: 100,
  deploymentBlock: 0n,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EvmAdapter finalityBlockTag (WP-BASE T0)", () => {
  it("defaults to finalized blockTag when no finalityBlockTag set", async () => {
    const adapter = new EvmAdapter(BASE_OPTS);

    mockReadContract.mockResolvedValue("0xAuthorityAddress");
    mockGetBlock.mockResolvedValue({ number: 0n });
    mockGetContractEvents.mockResolvedValue([]);

    await adapter.readEndpointConfigs();

    expect(mockGetBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
  });

  it("uses safe blockTag when finalityBlockTag is set to safe", async () => {
    const adapter = new EvmAdapter({
      ...BASE_OPTS,
      finalityBlockTag: "safe",
    });

    mockReadContract.mockResolvedValue("0xAuthorityAddress");
    mockGetBlock.mockResolvedValue({ number: 0n });
    mockGetContractEvents.mockResolvedValue([]);

    await adapter.readEndpointConfigs();

    expect(mockGetBlock).toHaveBeenCalledWith({ blockTag: "safe" });
  });
});
