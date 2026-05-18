import { describe, it, expect } from "vitest";
import {
  ARC_TESTNET,
  DEPLOYMENTS,
  getDeployment,
  resolveDeployment,
} from "../src/addresses.js";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from "../src/constants.js";

// Spec §5: addresses.ts is the EVM analogue of pda.ts — "deployed addresses
// per chain — no PDAs" (§4 #2). D-B (captain-approved): WP-07 deploy is
// deferred, so protocol contract addresses are null placeholders; chain id +
// USDC are known from ArcConfig and populated now.
describe("addresses — per-chain deployment registry (D-B)", () => {
  it("Arc Testnet entry has known constants and null contract placeholders", () => {
    const d = DEPLOYMENTS[ARC_TESTNET];
    expect(d.chainId).toBe(ARC_TESTNET_CHAIN_ID);
    expect(d.usdc).toBe(ARC_TESTNET_USDC);
    expect(d.registry).toBeNull();
    expect(d.pool).toBeNull();
    expect(d.settler).toBeNull();
  });

  it("getDeployment returns the chain entry; throws on unknown chain", () => {
    expect(getDeployment(ARC_TESTNET).chainId).toBe(ARC_TESTNET_CHAIN_ID);
    expect(() => getDeployment(999999)).toThrow();
  });

  it("resolveDeployment overlays env-provided contract addresses", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    const r = resolveDeployment(ARC_TESTNET, {
      PACT_EVM_REGISTRY: addr,
      PACT_EVM_POOL: addr,
      PACT_EVM_SETTLER: addr,
    });
    expect(r.registry).toBe(addr);
    expect(r.pool).toBe(addr);
    expect(r.settler).toBe(addr);
    // USDC + chainId are never overridden by env.
    expect(r.usdc).toBe(ARC_TESTNET_USDC);
    expect(r.chainId).toBe(ARC_TESTNET_CHAIN_ID);
  });

  it("resolveDeployment rejects a malformed env address", () => {
    expect(() =>
      resolveDeployment(ARC_TESTNET, { PACT_EVM_REGISTRY: "not-an-address" }),
    ).toThrow();
  });
});
