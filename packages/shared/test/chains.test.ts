import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getChain, listChains } from "../src";

// Drift guard (PR #225 P0-2): `src/chains.ts` inlines the EVM chain table as a
// TS const instead of reading chains.json at module-load. This test reads the
// canonical JSON from disk and asserts the inlined registry matches it, so any
// edit to chains.json that is not mirrored into the const fails CI.
const _chainsJson = JSON.parse(
  readFileSync(
    join(__dirname, "../../program-evm/protocol-evm-v1/config/chains.json"),
    "utf-8",
  ),
) as Record<
  string,
  {
    chainId: number;
    usdcAddress: string;
    usdcDecimals: number;
    rpcUrl?: string | null;
    blockTimeMs?: number | null;
    finalityBlocks?: number | null;
    finalityBlockTag?: string | null;
    deploymentBlock?: number | null;
    logRangeChunk?: number | null;
  }
>;

describe("chains registry — inlined EVM const drift vs chains.json", () => {
  for (const [name, c] of Object.entries(_chainsJson)) {
    it(`${name} descriptor matches chains.json`, () => {
      const d = getChain(name);
      expect(d.vm).toBe("evm");
      expect(d.chainId).toBe(c.chainId);
      expect(d.usdcMint.toLowerCase()).toBe(c.usdcAddress.toLowerCase());
      expect(d.usdcDecimals).toBe(c.usdcDecimals);
      if (c.rpcUrl != null) expect(d.rpcUrl).toBe(c.rpcUrl);
      if (c.blockTimeMs != null) expect(d.blockTimeMs).toBe(c.blockTimeMs);
      if (c.finalityBlocks != null)
        expect(d.finalityBlocks).toBe(c.finalityBlocks);
      if (c.finalityBlockTag != null)
        expect(d.finalityBlockTag).toBe(c.finalityBlockTag);
      if (c.deploymentBlock != null)
        expect(d.deploymentBlock).toBe(c.deploymentBlock);
      if (c.logRangeChunk != null)
        expect(d.logRangeChunk).toBe(c.logRangeChunk);
    });
  }
});

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
