/**
 * Deployed-contract addresses per chain — the EVM analogue of
 * `protocol-v1-client/src/pda.ts` (design spec §5). EVM has no PDAs
 * (§4 #2): one set of contract addresses per chain, not per-endpoint
 * derivations.
 *
 * D-B (captain GATE-A APPROVED): WP-EVM-07 (deploy + arcscan verify) is a
 * separate, deferred cycle. WP-EVM-07 is now COMPLETE — the protocol contract
 * addresses below are the Arc Testnet (chain 5042002) deployed + arcscan-
 * verified contracts, baked permanently into `DEPLOYMENTS`. They remain
 * overridable via the `resolveDeployment` env overlay. The chain id and USDC
 * address are from `ProtocolInvariants.sol`. Parity-neutral.
 */
import { getAddress, isAddress, type Address } from "viem";

import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC, BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, BASE_MAINNET_CHAIN_ID, BASE_MAINNET_USDC, ARBITRUM_SEPOLIA_CHAIN_ID, ARBITRUM_SEPOLIA_USDC } from "./constants.js";

/** Arc Testnet chain id (registry key). */
export const ARC_TESTNET = ARC_TESTNET_CHAIN_ID;

/** One chain's Pact deployment. Contract addresses filled at WP-07. */
export interface PactDeployment {
  chainId: number;
  /** USDC token — sourced from chains.json via ARC_TESTNET_USDC; never env-overridable. */
  usdc: Address;
  /** PactRegistry address — WP-07 deployed / overridable via env. */
  registry: Address | null;
  /** PactPool address — WP-07 deployed / overridable via env. */
  pool: Address | null;
  /** PactSettler address — WP-07 deployed / overridable via env. */
  settler: Address | null;
}

/** Per-chain registry. Add new chains here as the protocol expands. */
export const DEPLOYMENTS: Record<number, PactDeployment> = {
  [ARC_TESTNET_CHAIN_ID]: {
    chainId: ARC_TESTNET_CHAIN_ID,
    usdc: ARC_TESTNET_USDC,
    // WP-EVM-07: deployed + arcscan-verified on Arc Testnet 2026-05-19.
    // EIP-55 checksummed via viem getAddress. arcscan:
    // https://testnet.arcscan.app/address/<addr>#code
    registry: "0x056BAC33546b5b51B8CF6f332379651f715B889C",
    pool: "0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE",
    settler: "0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f",
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    usdc: BASE_SEPOLIA_USDC,
    // WP-BASE T2: deployed on Base Sepolia 2026-05-25.
    registry: "0x056BAC33546b5b51B8CF6f332379651f715B889C",
    pool: "0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE",
    settler: "0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f",
  },
  [BASE_MAINNET_CHAIN_ID]: {
    chainId: BASE_MAINNET_CHAIN_ID,
    usdc: BASE_MAINNET_USDC,
    // Deployed on Base mainnet (8453) 2026-06-04, deploy block 46880730.
    registry: "0x8cf7Dd83877a6a254bf05E31A79d50bC7169221D",
    pool: "0xA3245C40d9C8448eeA03847CD2BFdDe41f7c14A4",
    settler: "0x21adb7C1aD28b332661DaB8d52d765610dBF162A",
  },
  [ARBITRUM_SEPOLIA_CHAIN_ID]: {
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    usdc: ARBITRUM_SEPOLIA_USDC,
    // Deployed on Arbitrum Sepolia (421614) 2026-06-12, deploy block 276425280.
    // Arbitrum Open House London buildathon. EIP-55 checksummed.
    registry: "0x79A91E5965094266d221Aaef8E66d6C364819edb",
    pool: "0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc",
    settler: "0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043",
  },
};

/** Look up a chain's deployment. Throws for an unknown chain id. */
export function getDeployment(chainId: number): PactDeployment {
  const d = DEPLOYMENTS[chainId];
  if (!d) {
    throw new Error(
      `no Pact deployment registered for chain id ${chainId} (known: ${Object.keys(
        DEPLOYMENTS,
      ).join(", ")})`,
    );
  }
  return { ...d };
}

/** Legacy GLOBAL env var names — apply to whichever single EVM chain runs. */
export const ENV_KEYS = {
  registry: "PACT_EVM_REGISTRY",
  pool: "PACT_EVM_POOL",
  settler: "PACT_EVM_SETTLER",
} as const;

function checksumOrThrow(raw: string, key: string): Address {
  if (!isAddress(raw)) {
    throw new Error(`${key}=${raw} is not a valid EVM address`);
  }
  return getAddress(raw);
}

/**
 * Derive a chain-scoped env key from a global key + network name, e.g.
 * (`PACT_EVM_REGISTRY`, `arc-testnet`) -> `PACT_EVM_REGISTRY_ARC_TESTNET`.
 * The suffix scheme (`network.replace(/-/g, "_").toUpperCase()`) matches the
 * keypair/rpc key convention in the services' adapters.service.ts.
 */
function perChainKey(globalKey: string, network: string): string {
  return `${globalKey}_${network.replace(/-/g, "_").toUpperCase()}`;
}

/**
 * Resolve a deployment, overlaying env-provided contract addresses onto the
 * static registry. `usdc`/`chainId` are never overridable. Used by the
 * settler `ChainAdapter` + indexer per-chain poller (design §6.2) which inject
 * the WP-07 addresses via environment until they are baked into `DEPLOYMENTS`.
 *
 * Resolution precedence per address (registry/pool/settler), highest first:
 *   1. per-chain key   PACT_EVM_<KIND>_<NETWORK_UPPER>  (multi-EVM scoping)
 *   2. legacy global   PACT_EVM_<KIND>                  (single-EVM-chain compat)
 *   3. baked value     DEPLOYMENTS[chainId][kind]
 * where NETWORK_UPPER = network.replace(/-/g, "_").toUpperCase().
 *
 * The per-chain key is what lets one fleet run two EVM chains with distinct
 * addresses; the global key keeps the existing single-chain Arc deploy working
 * unchanged when no per-chain key is set.
 */
export function resolveDeployment(
  chainId: number,
  network: string,
  env: Record<string, string | undefined> = process.env,
): PactDeployment {
  const base = getDeployment(chainId);
  const overlay = (
    globalKey: string,
    baked: Address | null,
  ): Address | null => {
    const scopedKey = perChainKey(globalKey, network);
    const raw = env[scopedKey] ?? env[globalKey];
    if (!raw) return baked;
    // Report the actual key that supplied the bad value for operator debugging.
    const sourceKey = env[scopedKey] ? scopedKey : globalKey;
    return checksumOrThrow(raw, sourceKey);
  };
  return {
    ...base,
    registry: overlay(ENV_KEYS.registry, base.registry),
    pool: overlay(ENV_KEYS.pool, base.pool),
    settler: overlay(ENV_KEYS.settler, base.settler),
  };
}
