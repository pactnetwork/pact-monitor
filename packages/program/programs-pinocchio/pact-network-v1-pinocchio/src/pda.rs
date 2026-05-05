use pinocchio::{account::AccountView, ProgramResult};
use solana_address::Address;

use crate::{error::PactError, ID};

pub const SEED_COVERAGE_POOL: &[u8] = b"coverage_pool";
pub const SEED_ENDPOINT: &[u8] = b"endpoint";
pub const SEED_CALL: &[u8] = b"call";
pub const SEED_SETTLEMENT_AUTHORITY: &[u8] = b"settlement_authority";
pub const SEED_TREASURY: &[u8] = b"treasury";
pub const SEED_PROTOCOL_CONFIG: &[u8] = b"protocol_config";

/// Per-endpoint coverage pool — derived from the endpoint slug. Each endpoint
/// owns its own pool; pools are atomically created with the endpoint and can
/// never exist independently.
pub fn derive_coverage_pool(slug: &[u8; 16]) -> (Address, u8) {
    Address::find_program_address(&[SEED_COVERAGE_POOL, slug], &ID)
}

pub fn derive_endpoint_config(slug: &[u8; 16]) -> (Address, u8) {
    Address::find_program_address(&[SEED_ENDPOINT, slug], &ID)
}

pub fn derive_call_record(call_id: &[u8; 16]) -> (Address, u8) {
    Address::find_program_address(&[SEED_CALL, call_id], &ID)
}

pub fn derive_settlement_authority() -> (Address, u8) {
    Address::find_program_address(&[SEED_SETTLEMENT_AUTHORITY], &ID)
}

pub fn derive_treasury() -> (Address, u8) {
    Address::find_program_address(&[SEED_TREASURY], &ID)
}

pub fn derive_protocol_config() -> (Address, u8) {
    Address::find_program_address(&[SEED_PROTOCOL_CONFIG], &ID)
}

// ---------------------------------------------------------------------------
// Privileged-account verification helpers (codex 2026-05-05 review fix)
//
// Every privileged handler that *reads* trusted fields off ProtocolConfig or
// Treasury (authority, usdc_mint, default fee recipients, treasury vault, …)
// must first prove the supplied account is the canonical, program-owned PDA.
// Without these checks a caller could pass in an attacker-crafted account at
// an arbitrary address with their own pubkey in the `authority` slot and
// bypass authorization.
//
// Both helpers return `PactError::InvalidProtocolConfig` on either a wrong
// address or a wrong owner — the failure mode is identical from a caller's
// point of view (the account is not the canonical singleton), and this
// keeps the on-chain log shape stable.
// ---------------------------------------------------------------------------

/// Verify that `account` is the canonical ProtocolConfig PDA AND is owned by
/// this program. Must be called BEFORE reading any field off the account.
#[inline]
pub fn verify_protocol_config(account: &AccountView) -> ProgramResult {
    let (expected, _bump) = derive_protocol_config();
    if account.address() != &expected {
        return Err(PactError::InvalidProtocolConfig.into());
    }
    if !account.owned_by(&ID) {
        return Err(PactError::InvalidProtocolConfig.into());
    }
    Ok(())
}

/// Verify that `account` is the canonical Treasury PDA AND is owned by this
/// program. Same vuln class as `verify_protocol_config`; same failure code
/// space (Treasury-specific) so the on-chain log is unambiguous.
#[inline]
pub fn verify_treasury(account: &AccountView) -> ProgramResult {
    let (expected, _bump) = derive_treasury();
    if account.address() != &expected {
        return Err(PactError::InvalidTreasury.into());
    }
    if !account.owned_by(&ID) {
        return Err(PactError::InvalidTreasury.into());
    }
    Ok(())
}
