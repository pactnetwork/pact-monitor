import { describe, it, expect } from "vitest";
import { SolanaAdapter, getChain } from "../src";

describe("SolanaAdapter — smoke", () => {
  it("constructs with a valid Solana descriptor", () => {
    const adapter = new SolanaAdapter({
      descriptor: getChain("solana-devnet"),
      rpcUrl: "http://localhost:8899",
    });
    expect(adapter.descriptor.vm).toBe("solana");
    expect(adapter.descriptor.network).toBe("solana-devnet");
  });

  it("rejects an EVM descriptor", () => {
    expect(
      () =>
        new SolanaAdapter({
          descriptor: getChain("arc-testnet"),
          rpcUrl: "http://localhost:8899",
        }),
    ).toThrow(/requires descriptor.vm === "solana"/);
  });
});
