/**
 * Constants for `@pact-network/protocol-evm-v1-client`.
 *
 * EVM analogue of `protocol-v1-client/src/constants.ts`. The parity
 * invariants mirror BOTH `ProtocolInvariants.sol` and the Solana
 * `pact-network-v1-pinocchio/src/constants.rs` — they are bit-identical
 * across both (design spec §3). Per spec §5 this module is also the ABI
 * re-export point (`constants.ts` — Arc chain id, ABI re-export).
 *
 * "lamports" naming is intentionally dropped (design spec §4 #8: USDC is the
 * Arc 6-decimal ERC-20); names follow `ProtocolInvariants.sol`, the EVM parity
 * authority.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Address } from "viem";

import { PactRegistryAbi } from "./abi/PactRegistry.js";
import { PactPoolAbi } from "./abi/PactPool.js";
import { PactSettlerAbi } from "./abi/PactSettler.js";
import { PactEventsAbi } from "./abi/PactEvents.js";
import { PactErrorsAbi } from "./abi/PactErrors.js";

// --- Arc Testnet network constants (sourced from config/chains.json, design PR #201 §4.8.4) ---

const _chainsJson = JSON.parse(
  readFileSync(
    join(__dirname, "../../program-evm/protocol-evm-v1/config/chains.json"),
    "utf-8",
  ),
) as Record<string, { chainId: number; usdcAddress: string; usdcDecimals: number }>;

/** Arc Testnet EVM chain id (sourced from chains.json["arc-testnet"].chainId). */
export const ARC_TESTNET_CHAIN_ID = _chainsJson["arc-testnet"].chainId;

/** Arc Testnet USDC token (sourced from chains.json["arc-testnet"].usdcAddress). */
export const ARC_TESTNET_USDC: Address = _chainsJson["arc-testnet"]
  .usdcAddress as Address;

/** Base Sepolia EVM chain id (sourced from chains.json["base-sepolia"].chainId). */
export const BASE_SEPOLIA_CHAIN_ID = _chainsJson["base-sepolia"].chainId;

/** Base Sepolia USDC token (sourced from chains.json["base-sepolia"].usdcAddress). */
export const BASE_SEPOLIA_USDC: Address = _chainsJson["base-sepolia"].usdcAddress as Address;

/** Base Mainnet EVM chain id (sourced from chains.json["base-mainnet"].chainId). */
export const BASE_MAINNET_CHAIN_ID = _chainsJson["base-mainnet"].chainId;

/** Base Mainnet USDC token (sourced from chains.json["base-mainnet"].usdcAddress). */
export const BASE_MAINNET_USDC: Address = _chainsJson["base-mainnet"].usdcAddress as Address;

/**
 * USDC decimals Pact's premium math assumes (Solana 6-decimal parity). The
 * live `IERC20(USDC).decimals() == 6` assertion is enforced on-chain in the
 * Foundry suite (WP-EVM-06 T8).
 */
export const EXPECTED_USDC_DECIMALS = 6;

// --- Ported from constants.rs / ProtocolInvariants.sol (parity invariants, spec §3) ---

/** Maximum events the protocol accepts in one `settleBatch` call. */
export const MAX_BATCH_SIZE = 50;

/** Minimum premium per call in USDC base units (constants.rs MIN_PREMIUM_LAMPORTS). */
export const MIN_PREMIUM = 100n;

/** Maximum number of fee recipients in EndpointConfig / ProtocolConfig. */
export const MAX_FEE_RECIPIENTS = 8;

/** Absolute hard ceiling on any individual or summed bps value. */
export const ABSOLUTE_FEE_BPS_CAP = 10_000;

/** Default ProtocolConfig.maxTotalFeeBps when the caller leaves it unset. */
export const DEFAULT_MAX_TOTAL_FEE_BPS = 3_000;

// --- ABI re-export (design spec §5) ---

export {
  PactRegistryAbi,
  PactPoolAbi,
  PactSettlerAbi,
  PactEventsAbi,
  PactErrorsAbi,
};
