/**
 * Constants for `@pact-network/protocol-v1-client`.
 *
 * Mirrors `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/constants.rs`
 * and `pda.rs`. Values flagged // CANONICAL are part of the public on-wire
 * contract — do not change without coordinating an on-chain redeploy.
 */
import { PublicKey } from "@solana/web3.js";

/**
 * Pact Network V1 program ID.
 *
 * CANONICAL mainnet deploy. Set 2026-05-06 in preparation for the V1 launch.
 * Upgrade authority is the laptop-held key `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL`
 * — slated to rotate to a Squads multisig 2-4 weeks post-launch.
 *
 * Local development against devnet/surfpool requires sed-replacing this constant
 * AND `declare_id!()` in `lib.rs` to a per-environment program ID, then rebuilding
 * the SBF binary. The smoke harness at `scripts/smoke-tier2/01-deploy.sh` does this
 * automatically with a trap to revert.
 */
export const PROGRAM_ID = new PublicKey(
  "5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc"
);

/**
 * Orphaned program IDs from earlier deploys. Kept here only so off-chain log
 * scrapers and migration tooling can recognise legacy traffic. New code MUST NOT
 * send transactions to these program IDs.
 *
 * - `DhWibM…`: pre-Step-C Wave 1A devnet deploy, replaced by `5jBQb7fL…`
 * - `5jBQb7fL…`: Step-C devnet deploy, replaced by mainnet `5bCJcdWdK…`
 */
export const ORPHAN_PROGRAM_ID_PRE_STEP_C = new PublicKey(
  "DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc"
);

export const ORPHAN_PROGRAM_ID_DEVNET_STEP_C = new PublicKey(
  "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"
);

/** Devnet USDC mint that the program hardcodes in src/constants.rs. */
export const USDC_MINT_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

/** Mainnet USDC mint hardcoded in src/constants.rs. */
export const USDC_MINT_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

/** Standard SPL Token program. */
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

/** Maximum number of fee_recipients in EndpointConfig / ProtocolConfig. */
export const MAX_FEE_RECIPIENTS = 8;

/** Minimum premium per call in USDC base units (matches MIN_PREMIUM_LAMPORTS). */
export const MIN_PREMIUM_LAMPORTS = 100n;

/** Maximum number of events the program will accept in one settle_batch call. */
export const MAX_BATCH_SIZE = 50;

/** Default ProtocolConfig.max_total_fee_bps when caller leaves it unset. */
export const DEFAULT_MAX_TOTAL_FEE_BPS = 3000;

/** Absolute hard ceiling on any individual or summed bps value. */
export const ABSOLUTE_FEE_BPS_CAP = 10_000;

// ---------------------------------------------------------------------------
// PDA seeds — must match src/pda.rs verbatim.
// ---------------------------------------------------------------------------
export const SEED_COVERAGE_POOL = Buffer.from("coverage_pool");
export const SEED_ENDPOINT = Buffer.from("endpoint");
export const SEED_CALL = Buffer.from("call");
export const SEED_SETTLEMENT_AUTHORITY = Buffer.from("settlement_authority");
export const SEED_TREASURY = Buffer.from("treasury");
export const SEED_PROTOCOL_CONFIG = Buffer.from("protocol_config");

// ---------------------------------------------------------------------------
// Discriminator bytes — must match src/discriminator.rs.
// Numbering policy (per program comments): deleted slots are reserved gaps.
// ---------------------------------------------------------------------------
export const DISC_INITIALIZE_SETTLEMENT_AUTHORITY = 1;
export const DISC_REGISTER_ENDPOINT = 2;
export const DISC_UPDATE_ENDPOINT_CONFIG = 3;
export const DISC_PAUSE_ENDPOINT = 4;
export const DISC_TOP_UP_COVERAGE_POOL = 9;
export const DISC_SETTLE_BATCH = 10;
export const DISC_INITIALIZE_PROTOCOL_CONFIG = 12;
export const DISC_INITIALIZE_TREASURY = 13;
export const DISC_UPDATE_FEE_RECIPIENTS = 14;
export const DISC_PAUSE_PROTOCOL = 15;
