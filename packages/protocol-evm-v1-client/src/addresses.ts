/**
 * Deployed-contract addresses per chain — the EVM analogue of
 * `protocol-v1-client/src/pda.ts` (design spec §5). EVM has no PDAs
 * (§4 #2): one set of contract addresses per chain, not per-endpoint
 * derivations.
 *
 * D-B (captain GATE-A APPROVED): WP-EVM-07 (deploy + arcscan verify) is a
 * separate, deferred cycle, so the protocol contract addresses are not known
 * yet — they are `null` placeholders here, overridable via env at integration
 * time and filled permanently at WP-07. The chain id and USDC address ARE
 * known now (from `ArcConfig.sol`) and populated. Parity-neutral.
 */
import { getAddress, isAddress, type Address } from "viem";

import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from "./constants.js";

/** Arc Testnet chain id (registry key). */
export const ARC_TESTNET = ARC_TESTNET_CHAIN_ID;

/** One chain's Pact deployment. Contract addresses are null until WP-07. */
export interface PactDeployment {
  chainId: number;
  /** USDC token — known from ArcConfig; never env-overridable. */
  usdc: Address;
  /** PactRegistry address — filled at WP-07 / overridable via env. */
  registry: Address | null;
  /** PactPool address — filled at WP-07 / overridable via env. */
  pool: Address | null;
  /** PactSettler address — filled at WP-07 / overridable via env. */
  settler: Address | null;
}

/** Per-chain registry. Add new chains here as the protocol expands. */
export const DEPLOYMENTS: Record<number, PactDeployment> = {
  [ARC_TESTNET_CHAIN_ID]: {
    chainId: ARC_TESTNET_CHAIN_ID,
    usdc: ARC_TESTNET_USDC,
    registry: null,
    pool: null,
    settler: null,
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

/** Env var names consumers set once WP-07 deploy addresses exist. */
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
 * Resolve a deployment, overlaying env-provided contract addresses onto the
 * static registry. `usdc`/`chainId` are never overridable. Used by the
 * settler `ChainAdapter` + indexer per-chain poller (design §6.2) which inject
 * the WP-07 addresses via environment until they are baked into `DEPLOYMENTS`.
 */
export function resolveDeployment(
  chainId: number,
  env: Record<string, string | undefined> = process.env,
): PactDeployment {
  const base = getDeployment(chainId);
  const reg = env[ENV_KEYS.registry];
  const pool = env[ENV_KEYS.pool];
  const settler = env[ENV_KEYS.settler];
  return {
    ...base,
    registry: reg ? checksumOrThrow(reg, ENV_KEYS.registry) : base.registry,
    pool: pool ? checksumOrThrow(pool, ENV_KEYS.pool) : base.pool,
    settler: settler ? checksumOrThrow(settler, ENV_KEYS.settler) : base.settler,
  };
}
