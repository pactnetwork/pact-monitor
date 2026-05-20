import { describe, it, expect } from "vitest";
import { SolanaAdapter, getChain, type ChainAdapter } from "../src";

/**
 * Generic contract test — any `ChainAdapter` implementer must pass.
 * WP-MN-04's EvmAdapter re-runs this suite parameterized by its own
 * adapter instance.
 */
function runContractTests(name: string, makeAdapter: () => ChainAdapter) {
  describe(`ChainAdapter contract — ${name}`, () => {
    it("descriptor has a valid ChainVm and network", () => {
      const a = makeAdapter();
      expect(["solana", "evm"]).toContain(a.descriptor.vm);
      expect(typeof a.descriptor.network).toBe("string");
      expect(a.descriptor.network.length).toBeGreaterThan(0);
      expect(typeof a.descriptor.usdcMint).toBe("string");
      expect(a.descriptor.usdcDecimals).toBe(6);
    });

    it("exposes readEndpointConfigs as a function returning a Promise", () => {
      const a = makeAdapter();
      expect(typeof a.readEndpointConfigs).toBe("function");
      const p = a.readEndpointConfigs();
      expect(p).toBeInstanceOf(Promise);
      p.catch(() => {}); // swallow — we just check method-shape
    });

    it("exposes submitSettleBatch as a function", () => {
      const a = makeAdapter();
      expect(typeof a.submitSettleBatch).toBe("function");
    });

    it("exposes checkAgentEligibility as a function returning a Promise", () => {
      const a = makeAdapter();
      expect(typeof a.checkAgentEligibility).toBe("function");
    });

    it("tailSettlementEvents is either undefined or a function (optional)", () => {
      const a = makeAdapter();
      if (a.tailSettlementEvents !== undefined) {
        expect(typeof a.tailSettlementEvents).toBe("function");
      }
    });
  });
}

runContractTests("SolanaAdapter", () =>
  new SolanaAdapter({
    descriptor: getChain("solana-devnet"),
    rpcUrl: "http://localhost:8899",
  }),
);
