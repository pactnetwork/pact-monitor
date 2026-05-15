/** 16-byte slug, matches v1's account-seed length. */
export const SLUG_LEN = 16;

/** 16-byte call id, matches v1's CallRecord sentinel. */
export const CALL_ID_LEN = 16;

/** v1 parity constants — must match packages/program/programs-pinocchio/.../constants.rs */
export const MAX_BATCH_SIZE = 50;
export const MAX_TOTAL_FEE_BPS = 3_000; // 30 %
export const MAX_FEE_RECIPIENTS = 8;

/** 0G chain ids. */
export const ZEROG_MAINNET_CHAIN_ID = 16_661;
export const ZEROG_TESTNET_CHAIN_ID = 16_602;
