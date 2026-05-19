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

  it("devnet leaves programId null (B1 NOT resolved — settle_batch unproven)", () => {
    // The devnet deploy 5jBQ… is live for reads, but the program binary's
    // declare_id! is the mainnet id 5bCJ…, so settle_batch reverts
    // InvalidSeeds on devnet. Account liveness alone does not prove B1; we
    // do NOT ship a devnet default until a declare_id-matching redeploy.
    // Opt in via createPact({ programId: PROGRAM_ID_DEVNET.toBase58() }).
    expect(NETWORK_CONFIGS.devnet.programId).toBeNull();
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
