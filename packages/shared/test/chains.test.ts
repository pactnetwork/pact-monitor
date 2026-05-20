import { describe, it, expect } from "vitest";
import { getChain, listChains } from "../src";

describe("chains registry (WP-MN-02 D2)", () => {
  it("resolves arc-testnet from program-evm config/chains.json", () => {
    const c = getChain("arc-testnet");
    expect(c.vm).toBe("evm");
    expect(c.network).toBe("arc-testnet");
    expect(c.chainId).toBe(5042002);
    expect(c.usdcMint.toLowerCase()).toBe(
      "0x3600000000000000000000000000000000000000",
    );
    expect(c.usdcDecimals).toBe(6);
  });

  it("resolves solana-devnet from hand-coded entries", () => {
    const c = getChain("solana-devnet");
    expect(c.vm).toBe("solana");
    expect(c.network).toBe("solana-devnet");
    expect(c.chainId).toBeUndefined();
    expect(c.usdcMint).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(c.usdcDecimals).toBe(6);
  });

  it("resolves solana-mainnet from hand-coded entries", () => {
    const c = getChain("solana-mainnet");
    expect(c.vm).toBe("solana");
    expect(c.network).toBe("solana-mainnet");
    expect(c.usdcMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("throws on unknown network", () => {
    expect(() => getChain("nonexistent-chain")).toThrow();
  });

  it("listChains returns all registered descriptors", () => {
    const list = listChains();
    const names = list.map((c) => c.network);
    expect(names).toContain("arc-testnet");
    expect(names).toContain("solana-devnet");
    expect(names).toContain("solana-mainnet");
  });

  it("every chain's usdcDecimals equals the protocol-wide invariant (6)", () => {
    for (const c of listChains()) {
      expect(c.usdcDecimals, `${c.network}.usdcDecimals`).toBe(6);
    }
  });
});
