/**
 * Constants for `@pact-network/protocol-evm-v1-client`.
 *
 * EVM analogue of `protocol-v1-client/src/constants.ts`. The parity
 * invariants mirror BOTH `ArcConfig.sol` and the Solana
 * `pact-network-v1-pinocchio/src/constants.rs` — they are bit-identical
 * across both (design spec §3). Per spec §5 this module is also the ABI
 * re-export point (`constants.ts` — Arc chain id, ABI re-export).
 *
 * "lamports" naming is intentionally dropped (design spec §4 #8: USDC is the
 * Arc 6-decimal ERC-20); names follow `ArcConfig.sol`, the EVM parity
 * authority.
 */
import type { Address } from "viem";

import { PactRegistryAbi } from "./abi/PactRegistry.js";
import { PactPoolAbi } from "./abi/PactPool.js";
import { PactSettlerAbi } from "./abi/PactSettler.js";
import { PactEventsAbi } from "./abi/PactEvents.js";
import { PactErrorsAbi } from "./abi/PactErrors.js";

// --- Arc Testnet network constants (source: ArcConfig.sol, design PR #201 §4.8.4) ---

/** Arc Testnet EVM chain id. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** Arc Testnet USDC token (Arc's native gas token; Pact uses its 6-dec ERC-20). */
export const ARC_TESTNET_USDC: Address =
  "0x3600000000000000000000000000000000000000";

/**
 * USDC decimals Pact's premium math assumes (Solana 6-decimal parity). The
 * live `IERC20(USDC).decimals() == 6` assertion is enforced on-chain in the
 * Foundry suite (WP-EVM-06 T8).
 */
export const EXPECTED_USDC_DECIMALS = 6;

// --- Ported from constants.rs / ArcConfig.sol (parity invariants, spec §3) ---

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
