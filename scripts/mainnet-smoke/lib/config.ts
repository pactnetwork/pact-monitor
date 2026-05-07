/**
 * Loads environment configuration for the real-mainnet smoke harness.
 *
 * Required env (no defaults — every variable must be set explicitly so we
 * never silently target the wrong cluster or proxy):
 *
 *   MAINNET_RPC_URL          Alchemy mainnet RPC (e.g. https://solana-mainnet.g.alchemy.com/v2/<key>).
 *                            Used only for read-side reconcile; the proxy uses
 *                            its own RPC config (also Alchemy in production).
 *   INDEXER_URL              Public indexer base URL (e.g. https://indexer.pactnetwork.io).
 *   MARKET_PROXY_URL         Public market-proxy base URL (e.g. https://market.pactnetwork.io).
 *   TEST_AGENT_KEYPAIR_PATH  Local filesystem path to the dedicated mainnet test
 *                            agent's keypair JSON (64-byte Solana secret-key
 *                            array). NEVER commit this file.
 *
 * Optional env:
 *
 *   MAINNET_PROGRAM_ID       Override the V1 program ID (default: protocol-v1-client constant).
 *   USDC_MINT                Override USDC mint (default: USDC_MINT_MAINNET).
 *   SETTLER_DRAIN_MS         How long 01-fire-10-calls waits after the last
 *                            publish for the settler to drain (default 60000).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  USDC_MINT_MAINNET,
} from "@pact-network/protocol-v1-client";

export interface SmokeConfig {
  rpcUrl: string;
  indexerUrl: string;
  marketProxyUrl: string;
  programId: PublicKey;
  usdcMint: PublicKey;
  testAgent: Keypair;
  testAgentKeypairPath: string;
  settlerDrainMs: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `Missing required env ${name}.\n` +
        `Set it before running. Example:\n  export ${name}=...`,
    );
  }
  return v;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function readKeypair(path: string): Keypair {
  if (!existsSync(path)) {
    throw new Error(
      `Test agent keypair not found at: ${path}\n` +
        `Generate or copy your mainnet test agent keypair to that path, then\n` +
        `fund it with USDC + a small amount of SOL. Pubkey will be printed by\n` +
        `00-preflight.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  const bytes = JSON.parse(raw);
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(
      `Invalid keypair file at ${path}: expected JSON array of 64 bytes.`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function loadConfig(): SmokeConfig {
  const rpcUrl = requireEnv("MAINNET_RPC_URL");
  const indexerUrl = trimTrailingSlash(requireEnv("INDEXER_URL"));
  const marketProxyUrl = trimTrailingSlash(requireEnv("MARKET_PROXY_URL"));
  const testAgentKeypairPath = expandHome(requireEnv("TEST_AGENT_KEYPAIR_PATH"));

  const programIdEnv = process.env.MAINNET_PROGRAM_ID;
  const programId = programIdEnv ? new PublicKey(programIdEnv) : PROGRAM_ID;

  const usdcMintEnv = process.env.USDC_MINT;
  const usdcMint = usdcMintEnv ? new PublicKey(usdcMintEnv) : USDC_MINT_MAINNET;

  const drainMsEnv = process.env.SETTLER_DRAIN_MS;
  const settlerDrainMs = drainMsEnv ? Number(drainMsEnv) : 60_000;
  if (!Number.isFinite(settlerDrainMs) || settlerDrainMs < 0) {
    throw new Error(`Invalid SETTLER_DRAIN_MS=${drainMsEnv}`);
  }

  const testAgent = readKeypair(testAgentKeypairPath);

  return {
    rpcUrl,
    indexerUrl,
    marketProxyUrl,
    programId,
    usdcMint,
    testAgent,
    testAgentKeypairPath,
    settlerDrainMs,
  };
}

/**
 * Five user-facing endpoint slugs the protocol insures on mainnet at launch.
 * NOTE: the `helius` slug is the *user-facing slug* for the Helius RPC API
 * we insure on behalf of agents — separate from which RPC provider the
 * protocol itself uses internally for sending settle_batch txs (Alchemy).
 */
export const MAINNET_ENDPOINT_SLUGS = [
  "helius",
  "birdeye",
  "jupiter",
  "elfa",
  "fal",
] as const;

export type MainnetEndpointSlug = (typeof MAINNET_ENDPOINT_SLUGS)[number];
