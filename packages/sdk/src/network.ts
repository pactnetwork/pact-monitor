/**
 * Per-network configuration.
 *
 * `programId` derives the SettlementAuthority delegate PDA, so a wrong value
 * silently sends the agent's SPL approve to the wrong delegate and
 * premiums/refunds never settle. Both public networks now carry a verified
 * canonical ID:
 * - mainnet  = `PROGRAM_ID` (`5bCJcdWdK…`)
 * - devnet   = `PROGRAM_ID_DEVNET` (`5jBQb7fL…`) — verified LIVE on
 *   `api.devnet.solana.com` 2026-05-18 via `scripts/devnet/verify-network.ts`
 *   (former plan blocker B1, resolved on-chain; the old `constants.ts` ORPHAN
 *   label was a misnomer). Still overridable via `createPact({ programId })`.
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
  PROGRAM_ID_DEVNET,
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
    // B1 resolved: verified live on devnet 2026-05-18 (verify-network.ts).
    programId: PROGRAM_ID_DEVNET.toBase58(),
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
