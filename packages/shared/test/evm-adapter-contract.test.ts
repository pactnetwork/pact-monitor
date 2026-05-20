/**
 * EvmAdapter — ChainAdapter contract-conformance tests (WP-MN-04 T2).
 *
 * Shape-parity with WP-MN-02 SolanaAdapter conformance
 * (chain-adapter-contract.test.ts). Verifies structural invariants only —
 * no live RPC calls, no viem mocks.
 */
import { describe, it, expect } from "vitest";
import { EvmAdapter } from "../src/adapters/evm";
import { getChain } from "../src";

describe("EvmAdapter — ChainAdapter contract conformance (WP-MN-04 T2)", () => {
  const descriptor = getChain("arc-testnet");
  const opts = {
    descriptor,
    rpcUrl: descriptor.rpcUrl!,
    finalityBlocks: descriptor.finalityBlocks!,
    blockTimeMs: descriptor.blockTimeMs!,
    deploymentBlock: BigInt(descriptor.deploymentBlock!),
  };

  it("descriptor.vm === 'evm'", () => {
    const a = new EvmAdapter(opts);
    expect(a.descriptor.vm).toBe("evm");
  });

  it("rejects non-evm descriptor in constructor", () => {
    expect(() => new EvmAdapter({
      ...opts,
      descriptor: getChain("solana-devnet"),
    })).toThrow(/descriptor\.vm/);
  });

  it("exposes the 3 required ChainAdapter methods", () => {
    const a = new EvmAdapter(opts);
    expect(typeof a.readEndpointConfigs).toBe("function");
    expect(typeof a.submitSettleBatch).toBe("function");
    expect(typeof a.checkAgentEligibility).toBe("function");
  });

  it("optionally exposes tailSettlementEvents", () => {
    const a = new EvmAdapter(opts);
    expect(typeof a.tailSettlementEvents).toBe("function");
  });
});
