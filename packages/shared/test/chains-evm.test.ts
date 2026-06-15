import { describe, it, expect } from "vitest";
import { getChain, listChains } from "../src";

describe("chains registry — EVM (WP-MN-04 T1)", () => {
  it("arc-testnet exposes deployment block, finality, rpc url, block time", () => {
    const c = getChain("arc-testnet");
    expect(c.vm).toBe("evm");
    expect(c.chainId).toBe(5042002);
    expect(c.rpcUrl).toBe("https://rpc.testnet.arc.network");
    expect(c.blockTimeMs).toBe(500);
    expect(c.finalityBlocks).toBe(64);
    expect(c.deploymentBlock).toBe(42953139);
  });

  it("solana-devnet does NOT carry EVM-only fields", () => {
    const c = getChain("solana-devnet");
    expect(c.vm).toBe("solana");
    expect(c.rpcUrl).toBeUndefined();
    expect(c.blockTimeMs).toBeUndefined();
    expect(c.finalityBlocks).toBeUndefined();
    expect(c.deploymentBlock).toBeUndefined();
  });
});
