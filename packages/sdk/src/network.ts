/**
 * Per-network configuration.
 *
 * `programId` is the one value the repo cannot answer for devnet/localnet
 * (plan blocker B1): `@pact-network/protocol-v1-client` ships `PROGRAM_ID`
 * for mainnet only and explicitly marks every prior devnet deploy ORPHAN
 * ("New code MUST NOT send transactions to these"). Because the
 * SettlementAuthority delegate PDA is derived from the program ID, guessing
 * it would silently send the agent's SPL approve to the wrong delegate and
 * premiums/refunds would never settle.
 *
 * Therefore: mainnet uses the canonical constant; devnet/localnet
 * `programId` is `null` until the operator passes a confirmed value via
 * `createPact({ programId })`. Proxy-routed covered calls, discovery, and
 * indexer reads do NOT need the program ID — only the explicit on-chain ops
 * (`setup`/`topUp`/`revoke`/`policy`) do, and those throw a clear error on
 * devnet/localnet when `programId` is unset.
 *
 * `indexerBaseUrl` reachability is unverified by any deploy manifest
 * (plan blocker B2): indexer polling is best-effort and never affects the
 * golden rule. Override the host if it differs from the published default.
 */
import {
  PROGRAM_ID,
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
} from "@pact-network/protocol-v1-client";

export type Network = "mainnet" | "devnet" | "localnet";

export interface NetworkConfig {
  /** Solana program ID. `null` => caller must supply one for on-chain ops. */
  programId: string | null;
  usdcMint: string;
  proxyBaseUrl: string;
  indexerBaseUrl: string;
  defaultRpcUrl: string;
}

export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  mainnet: {
    programId: PROGRAM_ID.toBase58(),
    usdcMint: USDC_MINT_MAINNET.toBase58(),
    proxyBaseUrl: "https://market.pactnetwork.io",
    indexerBaseUrl: "https://indexer.pactnetwork.io",
    defaultRpcUrl: "https://api.mainnet-beta.solana.com",
  },
  devnet: {
    // B1: unverified — operator must confirm and pass via config.
    programId: null,
    usdcMint: USDC_MINT_DEVNET.toBase58(),
    proxyBaseUrl: "https://market.pactnetwork.io",
    indexerBaseUrl: "https://indexer.pactnetwork.io",
    defaultRpcUrl: "https://api.devnet.solana.com",
  },
  localnet: {
    // Local builds sed-replace the program ID per-env (smoke-tier2 harness).
    programId: null,
    usdcMint: USDC_MINT_DEVNET.toBase58(),
    proxyBaseUrl: "http://localhost:3001",
    indexerBaseUrl: "http://localhost:3002",
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
    defaultRpcUrl: base.defaultRpcUrl,
    rpcUrl: overrides?.rpcUrl ?? base.defaultRpcUrl,
  };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
