use solana_address::Address;

use crate::ID;

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
