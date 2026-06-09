/**
 * Network registry — D2-locked owner per arch §11. `@pact-network/shared`
 * is the source of truth for "what networks does Pact support"; the SDK,
 * services, and adapters all consume from here.
 *
 * EVM chains are sourced from `program-evm/protocol-evm-v1/config/chains.json`
 * (WP-MN-01's single source of truth). Solana entries are hand-coded from
 * `@q3labs/pact-protocol-v1-client` constants.
 */

import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "@q3labs/pact-protocol-v1-client";
import type { ChainDescriptor } from "./chain-adapter";

// EVM chain table — baked from `program-evm/protocol-evm-v1/config/chains.json`
// (WP-MN-01's single source of truth). Inlined as a TS const rather than read
// via `readFileSync` at module-load (PR #225 P0-2): the JSON does not ship in
// the service Docker images, and `__dirname`-relative reads are brittle (break
// under ESM where `__dirname` is undefined, under bundlers, and under pnpm
// hoisting variants). Drift from chains.json is caught at CI by the disk-read
// drift test in `test/chains.test.ts`; the foundry deploy still reads the JSON
// directly via `vm.readFile`, so chains.json remains the canonical source.
const _evmChains: Record<
  string,
  {
    chainId: number;
    name: string;
    usdcAddress: string;
    usdcDecimals: number;
    rpcUrl?: string | null;
    blockTimeMs?: number | null;
    finalityBlocks?: number | null;
    finalityBlockTag?: string | null;
    deploymentBlock?: number | null;
    logRangeChunk?: number | null;
  }
> = {
  "arc-testnet": {
    chainId: 5042002,
    name: "arc-testnet",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    usdcDecimals: 6,
    rpcUrl: "https://rpc.testnet.arc.network",
    blockTimeMs: 500,
    finalityBlocks: 64,
    finalityBlockTag: "finalized",
    deploymentBlock: 42953139,
    logRangeChunk: 9500,
  },
  "base-sepolia": {
    chainId: 84532,
    name: "base-sepolia",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDecimals: 6,
    rpcUrl: "https://sepolia.base.org",
    blockTimeMs: 2000,
    finalityBlocks: 1,
    finalityBlockTag: "safe",
    deploymentBlock: 41969204,
    logRangeChunk: 500,
  },
  "base-mainnet": {
    chainId: 8453,
    name: "base-mainnet",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    rpcUrl: "https://mainnet.base.org",
    blockTimeMs: 2000,
    finalityBlocks: 1,
    finalityBlockTag: "safe",
    deploymentBlock: 46880730,
    logRangeChunk: 500,
  },
};

const _evmEntries: Record<string, ChainDescriptor> = Object.fromEntries(
  Object.entries(_evmChains).map(([name, c]) => [
    name,
    {
      vm: "evm" as const,
      network: name,
      chainId: c.chainId,
      usdcMint: c.usdcAddress,
      usdcDecimals: c.usdcDecimals,
      ...(c.rpcUrl != null && { rpcUrl: c.rpcUrl }),
      ...(c.blockTimeMs != null && { blockTimeMs: c.blockTimeMs }),
      ...(c.finalityBlocks != null && { finalityBlocks: c.finalityBlocks }),
      ...(c.finalityBlockTag != null && { finalityBlockTag: c.finalityBlockTag as "safe" | "finalized" }),
      ...(c.deploymentBlock != null && { deploymentBlock: c.deploymentBlock }),
      ...(c.logRangeChunk != null && { logRangeChunk: c.logRangeChunk }),
    },
  ]),
);

const _solanaEntries: Record<string, ChainDescriptor> = {
  "solana-devnet": {
    vm: "solana",
    network: "solana-devnet",
    usdcMint: USDC_MINT_DEVNET.toBase58(),
    usdcDecimals: 6,
  },
  "solana-mainnet": {
    vm: "solana",
    network: "solana-mainnet",
    usdcMint: USDC_MINT_MAINNET.toBase58(),
    usdcDecimals: 6,
  },
};

const REGISTRY: Record<string, ChainDescriptor> = {
  ..._solanaEntries,
  ..._evmEntries,
};

export function getChain(name: string): ChainDescriptor {
  const c = REGISTRY[name];
  if (!c) {
    throw new Error(
      `unknown network "${name}" — known: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return { ...c };
}

export function listChains(): ReadonlyArray<ChainDescriptor> {
  return Object.values(REGISTRY).map((c) => ({ ...c }));
}
