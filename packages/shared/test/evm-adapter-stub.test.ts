import { describe, it, expect } from "vitest";
import { EvmAdapterStub, getChain } from "../src";

describe("EvmAdapterStub", () => {
  it("constructs with an EVM descriptor", () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    expect(stub.descriptor.vm).toBe("evm");
    expect(stub.descriptor.network).toBe("arc-testnet");
  });

  it("rejects a Solana descriptor", () => {
    expect(
      () => new EvmAdapterStub({ descriptor: getChain("solana-devnet") }),
    ).toThrow(/requires descriptor.vm === "evm"/);
  });

  it("readEndpointConfigs throws not-implemented", async () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    await expect(stub.readEndpointConfigs()).rejects.toThrow(/WP-MN-04/);
  });

  it("submitSettleBatch throws not-implemented", async () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    await expect(
      stub.submitSettleBatch({
        slug: "test",
        signer: {},
        events: [],
      }),
    ).rejects.toThrow(/WP-MN-04/);
  });

  it("checkAgentEligibility throws not-implemented", async () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    await expect(stub.checkAgentEligibility("0x", 100n)).rejects.toThrow(
      /WP-MN-04/,
    );
  });
});
