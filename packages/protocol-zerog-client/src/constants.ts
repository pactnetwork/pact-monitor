/** 16-byte slug, matches v1's account-seed length. */
export const SLUG_LEN = 16;

/** 16-byte call id, matches v1's CallRecord sentinel. */
export const CALL_ID_LEN = 16;

/** v1 parity constants — must match packages/program/programs-pinocchio/.../constants.rs */
export const MAX_BATCH_SIZE = 50;
export const MAX_TOTAL_FEE_BPS = 3_000; // 30 % — cap on the SUM of all recipient bps
export const MAX_FEE_RECIPIENTS = 8;

/**
 * Per-entry bps ceiling (v1 `ABSOLUTE_FEE_BPS_CAP`, fee.rs:64). Distinct from
 * `MAX_TOTAL_FEE_BPS`: a single recipient may declare up to 10_000 bps even
 * though the SUM across recipients is still capped at `MAX_TOTAL_FEE_BPS`.
 */
export const MAX_SINGLE_RECIPIENT_BPS = 10_000;

/** Minimum premium (sub-units). v1 `MIN_PREMIUM_LAMPORTS`, constants.rs:13. */
export const MIN_PREMIUM = 100n;

/** 0G chain ids. */
export const ZEROG_MAINNET_CHAIN_ID = 16_661;
export const ZEROG_TESTNET_CHAIN_ID = 16_602;
