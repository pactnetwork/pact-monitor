import { describe, it, expect } from "vitest";
import {
  ARC_TESTNET,
  DEPLOYMENTS,
  getDeployment,
  resolveDeployment,
} from "../src/addresses.js";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from "../src/constants.js";

// Spec §5: addresses.ts is the EVM analogue of pda.ts — "deployed addresses
// per chain — no PDAs" (§4 #2). WP-EVM-07 COMPLETE: the Arc Testnet protocol
// contracts are deployed + arcscan-verified (2026-05-19) and baked into
// DEPLOYMENTS (EIP-55 checksummed); chain id + USDC are from ArcConfig.
describe("addresses — per-chain deployment registry (D-B)", () => {
  it("Arc Testnet entry has known constants and WP-07 deployed addresses", () => {
    const d = DEPLOYMENTS[ARC_TESTNET];
    expect(d.chainId).toBe(ARC_TESTNET_CHAIN_ID);
    expect(d.usdc).toBe(ARC_TESTNET_USDC);
    // WP-EVM-07 Arc Testnet deployed + arcscan-verified contracts.
    expect(d.registry).toBe("0x056BAC33546b5b51B8CF6f332379651f715B889C");
    expect(d.pool).toBe("0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE");
    expect(d.settler).toBe("0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f");
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
