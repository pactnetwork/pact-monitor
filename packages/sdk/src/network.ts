/**
 * Per-network configuration.
 *
 * `programId` derives the SettlementAuthority delegate PDA, so a wrong value
 * silently sends the agent's SPL approve to the wrong delegate and
 * premiums/refunds never settle.
 * - mainnet  = `PROGRAM_ID` (`5bCJcdWdK…`) — canonical.
 * - devnet   = `null` (no static default). The devnet deploy `5jBQb7fL…`
 *   (`PROGRAM_ID_DEVNET`) is LIVE for reads/account-decode, BUT its binary's
 *   `declare_id!` is the MAINNET id `5bCJ…` (see
 *   `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/lib.rs`),
 *   so internally-derived PDAs do not match the deploy address and
 *   `settle_batch` reverts `InvalidSeeds` on devnet — refunds cannot settle.
 *   Until devnet is redeployed from a binary whose `declare_id!` == its
 *   deploy address, we do NOT ship it as a default. Operators who accept the
 *   limitation pass `createPact({ programId: PROGRAM_ID_DEVNET.toBase58() })`
 *   explicitly. (B1 is NOT resolved: account liveness alone does not prove
 *   `settle_batch` can execute — the strict CallRecord proof is the gate.)
 * - localnet = `null`: local builds sed-replace the program ID per-env
 *   (smoke-tier2 harness), so the operator must pass `programId`.
 *
 * Proxy-routed covered calls, discovery, and indexer reads do NOT need the
 * program ID — only explicit on-chain ops (`setup`/`topUp`/`revoke`/`policy`)
 * do, and those throw a clear error when `programId` is unset.
 *
 * `indexerBaseUrl` (`indexer.pactnetwork.io`) is reachable (former plan
 * blocker B2, probed green 2026-05-18); polling stays best-effort and never
 * affects the golden rule. Override the host if it differs.
 */
import {
  PROGRAM_ID,
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
} from "@q3labs/pact-protocol-v1-client";

export type Network = "mainnet" | "devnet" | "localnet";

export interface NetworkConfig {
  /** Solana program ID. `null` => caller must supply one for on-chain ops. */
  programId: string | null;
  usdcMint: string;
  proxyBaseUrl: string;
  indexerBaseUrl: string;
  /**
   * Pact backend host (legacy scorecard API). Used by the merchant SDK for
   * `/api/v1/observations`, `/api/v1/merchants`, etc. Distinct from the proxy
   * (market) and indexer hosts.
   */
  backendBaseUrl: string;
  defaultRpcUrl: string;
}

export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  mainnet: {
    programId: PROGRAM_ID.toBase58(),
    usdcMint: USDC_MINT_MAINNET.toBase58(),
    proxyBaseUrl: "https://market.pactnetwork.io",
    indexerBaseUrl: "https://indexer.pactnetwork.io",
    backendBaseUrl: "https://pactnetwork.io",
    defaultRpcUrl: "https://api.mainnet-beta.solana.com",
  },
  devnet: {
    // No static default: the devnet deploy is live for reads but its binary's
    // declare_id! is the mainnet id, so settle_batch reverts InvalidSeeds
    // (B1 NOT resolved). Pass programId explicitly to opt in. See header.
    programId: null,
    usdcMint: USDC_MINT_DEVNET.toBase58(),
    proxyBaseUrl: "https://market.pactnetwork.io",
    indexerBaseUrl: "https://indexer.pactnetwork.io",
    backendBaseUrl: "https://pactnetwork.io",
    defaultRpcUrl: "https://api.devnet.solana.com",
  },
  localnet: {
    // Local builds sed-replace the program ID per-env (smoke-tier2 harness).
    programId: null,
    usdcMint: USDC_MINT_DEVNET.toBase58(),
    proxyBaseUrl: "http://localhost:3001",
    indexerBaseUrl: "http://localhost:3002",
    backendBaseUrl: "http://localhost:3001",
    defaultRpcUrl: "http://127.0.0.1:8899",
  },
};

export interface ResolvedNetwork extends NetworkConfig {
  network: Network;
  rpcUrl: string;
}

/** Merge static per-network defaults with explicit user overrides. */
export function resolveNetwork(
  network: Network,
  overrides?: {
    programId?: string;
    usdcMint?: string;
    proxyBaseUrl?: string;
    indexerBaseUrl?: string;
    backendBaseUrl?: string;
    rpcUrl?: string;
  },
): ResolvedNetwork {
  const base = NETWORK_CONFIGS[network];
  if (!base) {
    throw new Error(`unknown network: ${String(network)}`);
  }
  return {
    network,
    programId: overrides?.programId ?? base.programId,
    usdcMint: overrides?.usdcMint ?? base.usdcMint,
    proxyBaseUrl: stripTrailingSlash(
      overrides?.proxyBaseUrl ?? base.proxyBaseUrl,
    ),
    indexerBaseUrl: stripTrailingSlash(
      overrides?.indexerBaseUrl ?? base.indexerBaseUrl,
    ),
    backendBaseUrl: stripTrailingSlash(
      overrides?.backendBaseUrl ?? base.backendBaseUrl,
    ),
    defaultRpcUrl: base.defaultRpcUrl,
    rpcUrl: overrides?.rpcUrl ?? base.defaultRpcUrl,
  };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
