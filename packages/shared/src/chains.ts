/**
 * Network registry — D2-locked owner per arch §11. `@pact-network/shared`
 * is the source of truth for "what networks does Pact support"; the SDK,
 * services, and adapters all consume from here.
 *
 * EVM chains are sourced from `program-evm/protocol-evm-v1/config/chains.json`
 * (WP-MN-01's single source of truth). Solana entries are hand-coded from
 * `@pact-network/protocol-v1-client` constants.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "@pact-network/protocol-v1-client";
import type { ChainDescriptor } from "./chain-adapter";

const _evmChainsPath = join(
  __dirname,
  "../../program-evm/protocol-evm-v1/config/chains.json",
);
const _evmChains = JSON.parse(readFileSync(_evmChainsPath, "utf-8")) as Record<
  string,
  {
    chainId: number;
    name: string;
    usdcAddress: string;
    usdcDecimals: number;
  }
>;

const _evmEntries: Record<string, ChainDescriptor> = Object.fromEntries(
  Object.entries(_evmChains).map(([name, c]) => [
    name,
    {
      vm: "evm" as const,
      network: name,
      chainId: c.chainId,
      usdcMint: c.usdcAddress,
      usdcDecimals: c.usdcDecimals,
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
