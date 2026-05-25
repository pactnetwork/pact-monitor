import { describe, it, expect } from "vitest";
import {
  ARC_TESTNET,
  DEPLOYMENTS,
  getDeployment,
  resolveDeployment,
} from "../src/addresses.js";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_USDC,
} from "../src/constants.js";

// Spec §5: addresses.ts is the EVM analogue of pda.ts — "deployed addresses
// per chain — no PDAs" (§4 #2). WP-EVM-07 COMPLETE: the Arc Testnet protocol
// contracts are deployed + arcscan-verified (2026-05-19) and baked into
// DEPLOYMENTS (EIP-55 checksummed); chain id + USDC are from ProtocolInvariants + chains.json.
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

  it("resolveDeployment overlays env-provided contract addresses (legacy global keys)", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    const r = resolveDeployment(ARC_TESTNET, "arc-testnet", {
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
      resolveDeployment(ARC_TESTNET, "arc-testnet", {
        PACT_EVM_REGISTRY: "not-an-address",
      }),
    ).toThrow();
  });
});

// Multi-EVM WP T1: deployment env keys are chain-scoped so two EVM chains in
// one fleet can carry distinct overrides. Precedence per kind:
//   1. per-chain key  PACT_EVM_<KIND>_<NETWORK_UPPER>
//   2. legacy global  PACT_EVM_<KIND>
//   3. baked DEPLOYMENTS value
// where NETWORK_UPPER = network.replace(/-/g, "_").toUpperCase() (matches the
// adapters.service.ts keypair/rpc convention).
describe("resolveDeployment — chain-scoped env overlay (multi-evm WP T1)", () => {
  const PER_CHAIN = "0x1111111111111111111111111111111111111111";
  const GLOBAL = "0x2222222222222222222222222222222222222222";
  // Baked Arc Testnet WP-07 addresses (checksummed in DEPLOYMENTS).
  const BAKED_REGISTRY = "0x056BAC33546b5b51B8CF6f332379651f715B889C";
  const BAKED_POOL = "0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE";
  const BAKED_SETTLER = "0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f";

  it("(a) per-chain key wins over the legacy global key", () => {
    const r = resolveDeployment(ARC_TESTNET, "arc-testnet", {
      PACT_EVM_REGISTRY_ARC_TESTNET: PER_CHAIN,
      PACT_EVM_REGISTRY: GLOBAL,
    });
    expect(r.registry).toBe(PER_CHAIN);
  });

  it("(b) legacy global key still applies when no per-chain key is set", () => {
    const r = resolveDeployment(ARC_TESTNET, "arc-testnet", {
      PACT_EVM_REGISTRY: GLOBAL,
      PACT_EVM_POOL: GLOBAL,
      PACT_EVM_SETTLER: GLOBAL,
    });
    expect(r.registry).toBe(GLOBAL);
    expect(r.pool).toBe(GLOBAL);
    expect(r.settler).toBe(GLOBAL);
  });

  it("(c) baked DEPLOYMENTS value used when neither per-chain nor global key is set", () => {
    const r = resolveDeployment(ARC_TESTNET, "arc-testnet", {});
    expect(r.registry).toBe(BAKED_REGISTRY);
    expect(r.pool).toBe(BAKED_POOL);
    expect(r.settler).toBe(BAKED_SETTLER);
  });

  it("scopes the suffix by network name (dashes -> underscores, uppercased)", () => {
    const r = resolveDeployment(ARC_TESTNET, "arc-testnet", {
      // Wrong-suffix key must be ignored; only the correctly-derived suffix wins.
      PACT_EVM_REGISTRY_ARCTESTNET: GLOBAL,
      PACT_EVM_REGISTRY_ARC_TESTNET: PER_CHAIN,
    });
    expect(r.registry).toBe(PER_CHAIN);
  });

  it("resolves per-kind independently (per-chain registry + global pool + baked settler)", () => {
    const r = resolveDeployment(ARC_TESTNET, "arc-testnet", {
      PACT_EVM_REGISTRY_ARC_TESTNET: PER_CHAIN,
      PACT_EVM_POOL: GLOBAL,
    });
    expect(r.registry).toBe(PER_CHAIN);
    expect(r.pool).toBe(GLOBAL);
    expect(r.settler).toBe(BAKED_SETTLER);
  });
});

describe("addresses — Base chain DEPLOYMENTS (pre-deploy placeholders)", () => {
  it("Base Sepolia entry exists with null contract addresses", () => {
    const d = DEPLOYMENTS[84532];
    expect(d).toBeDefined();
    expect(d.chainId).toBe(84532);
    expect(d.usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(d.registry).toBeNull();
    expect(d.pool).toBeNull();
    expect(d.settler).toBeNull();
  });

  it("Base Mainnet entry exists with null contract addresses", () => {
    const d = DEPLOYMENTS[8453];
    expect(d).toBeDefined();
    expect(d.chainId).toBe(8453);
    expect(d.usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(d.registry).toBeNull();
    expect(d.pool).toBeNull();
    expect(d.settler).toBeNull();
  });
});
