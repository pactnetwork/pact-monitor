import { describe, it, expect } from "vitest";
import { NETWORK_CONFIGS, resolveNetwork } from "../network.js";

describe("network config", () => {
  it("mainnet carries the canonical program ID", () => {
    expect(NETWORK_CONFIGS.mainnet.programId).toBe(
      "5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc",
    );
    expect(NETWORK_CONFIGS.mainnet.usdcMint).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  it("devnet carries the verified canonical program ID (B1 resolved)", () => {
    // B1 resolved 2026-05-18: 5jBQ… proven live on devnet via
    // scripts/devnet/verify-network.ts. The old constants.ts ORPHAN label
    // was a misnomer; network:"devnet" now carries it by default.
    expect(NETWORK_CONFIGS.devnet.programId).toBe(
      "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    );
    expect(NETWORK_CONFIGS.devnet.usdcMint).toBe(
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    );
  });

  it("localnet leaves programId null (sed-replaced per-env build)", () => {
    expect(NETWORK_CONFIGS.localnet.programId).toBeNull();
  });

  it("resolveNetwork applies overrides and strips trailing slashes", () => {
    const r = resolveNetwork("devnet", {
      programId: "ProGram1111111111111111111111111111111111111",
      proxyBaseUrl: "https://staging.example.com/",
      rpcUrl: "https://rpc.example.com",
    });
    expect(r.programId).toBe("ProGram1111111111111111111111111111111111111");
    expect(r.proxyBaseUrl).toBe("https://staging.example.com");
    expect(r.rpcUrl).toBe("https://rpc.example.com");
    expect(r.network).toBe("devnet");
  });

  it("resolveNetwork falls back to per-network defaults", () => {
    const r = resolveNetwork("mainnet");
    expect(r.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(r.proxyBaseUrl).toBe("https://market.pactnetwork.io");
    expect(r.indexerBaseUrl).toBe("https://indexer.pactnetwork.io");
  });

  it("throws on an unknown network", () => {
    // @ts-expect-error deliberate misuse
    expect(() => resolveNetwork("testnet")).toThrow(/unknown network/);
  });
});
