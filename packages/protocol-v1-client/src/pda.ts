/**
 * PDA derivers for the Pact Network V1 program.
 *
 * Each helper mirrors a `derive_*` function in
 * `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/pda.rs`.
 * All slug-keyed PDAs use a fixed-length 16-byte slug (UTF-8, right-padded
 * with NUL).
 */
import { PublicKey } from "@solana/web3.js";

import {
  PROGRAM_ID,
  SEED_COVERAGE_POOL,
  SEED_ENDPOINT,
  SEED_CALL,
  SEED_SETTLEMENT_AUTHORITY,
  SEED_TREASURY,
  SEED_PROTOCOL_CONFIG,
} from "./constants.js";

/** Length of the slug used in PDA derivations. */
export const SLUG_LEN = 16;
/** Length of the call_id used in CallRecord derivation. */
export const CALL_ID_LEN = 16;

/**
 * Convert a string slug to its canonical 16-byte representation: UTF-8 encoded,
 * truncated, right-padded with NUL. Matches the program's `slugBytes()`
 * convention.
 */
export function slugBytes(slug: string): Uint8Array {
  const out = new Uint8Array(SLUG_LEN);
  const enc = new TextEncoder().encode(slug);
  out.set(enc.subarray(0, SLUG_LEN));
  return out;
}

function normalizeSlug(slug: Uint8Array | string): Uint8Array {
  if (typeof slug === "string") return slugBytes(slug);
  if (slug.length === SLUG_LEN) return slug;
  if (slug.length > SLUG_LEN) {
    throw new Error(
      `endpoint slug must be <= ${SLUG_LEN} bytes (got ${slug.length})`
    );
  }
  const out = new Uint8Array(SLUG_LEN);
  out.set(slug);
  return out;
}

function normalizeCallId(callId: Uint8Array): Uint8Array {
  if (callId.length !== CALL_ID_LEN) {
    throw new Error(
      `call_id must be exactly ${CALL_ID_LEN} bytes (got ${callId.length})`
    );
  }
  return callId;
}

/**
 * Per-endpoint coverage pool PDA: `[b"coverage_pool", slug]`.
 * Each endpoint owns its own pool — pools and endpoints are co-created in
 * `register_endpoint`.
 */
export function getCoveragePoolPda(
  programId: PublicKey,
  endpointSlug: Uint8Array | string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_COVERAGE_POOL, Buffer.from(normalizeSlug(endpointSlug))],
    programId
  );
}

/**
 * The CoveragePool USDC vault is **not** a derived ATA — it's a freshly
 * generated keypair pre-allocated by the caller and bound to the pool PDA via
 * `InitializeAccount3` inside `register_endpoint`. Callers store the resulting
 * pubkey in their off-chain store; this helper just reads it back from the
 * decoded `CoveragePool.usdcVault` field.
 *
 * Returns the pool's USDC vault by reading the on-chain `CoveragePool` account.
 */
export function getCoveragePoolVaultPda(
  poolUsdcVault: PublicKey
): PublicKey {
  return poolUsdcVault;
}

/**
 * EndpointConfig PDA: `[b"endpoint", slug]`.
 */
export function getEndpointConfigPda(
  programId: PublicKey,
  endpointSlug: Uint8Array | string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_ENDPOINT, Buffer.from(normalizeSlug(endpointSlug))],
    programId
  );
}

/**
 * CallRecord dedup PDA: `[b"call", call_id]`. Created once per settlement
 * event; used as a duplicate-detection sentinel.
 */
export function getCallRecordPda(
  programId: PublicKey,
  callId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_CALL, Buffer.from(normalizeCallId(callId))],
    programId
  );
}

/**
 * SettlementAuthority singleton PDA: `[b"settlement_authority"]`.
 *
 * This PDA also functions as the SPL Token delegate that agents pre-approve
 * (off-chain via `Approve`) so the program can pull premiums during
 * `settle_batch`.
 */
export function getSettlementAuthorityPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_SETTLEMENT_AUTHORITY],
    programId
  );
}

/**
 * Treasury singleton PDA: `[b"treasury"]`.
 */
export function getTreasuryPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_TREASURY], programId);
}

/**
 * The Treasury USDC vault is initialized by the program from a caller-supplied
 * keypair (see `initialize_treasury`). Read it back from the decoded
 * `Treasury.usdcVault` field.
 */
export function getTreasuryVaultPda(treasuryUsdcVault: PublicKey): PublicKey {
  return treasuryUsdcVault;
}

/**
 * ProtocolConfig singleton PDA: `[b"protocol_config"]`.
 */
export function getProtocolConfigPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_PROTOCOL_CONFIG],
    programId
  );
}
