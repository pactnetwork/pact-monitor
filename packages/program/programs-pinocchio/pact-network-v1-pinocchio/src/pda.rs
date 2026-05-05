use solana_address::Address;

use crate::ID;

pub const SEED_COVERAGE_POOL: &[u8] = b"coverage_pool";
pub const SEED_ENDPOINT: &[u8] = b"endpoint";
pub const SEED_AGENT_WALLET: &[u8] = b"agent_wallet";
pub const SEED_CALL: &[u8] = b"call";
pub const SEED_SETTLEMENT_AUTHORITY: &[u8] = b"settlement_authority";

pub fn derive_coverage_pool() -> (Address, u8) {
    Address::find_program_address(&[SEED_COVERAGE_POOL], &ID)
}

pub fn derive_endpoint_config(slug: &[u8; 16]) -> (Address, u8) {
    Address::find_program_address(&[SEED_ENDPOINT, slug], &ID)
}

pub fn derive_agent_wallet(owner: &Address) -> (Address, u8) {
    Address::find_program_address(&[SEED_AGENT_WALLET, owner.as_ref()], &ID)
}

pub fn derive_call_record(call_id: &[u8; 16]) -> (Address, u8) {
    Address::find_program_address(&[SEED_CALL, call_id], &ID)
}

pub fn derive_settlement_authority() -> (Address, u8) {
    Address::find_program_address(&[SEED_SETTLEMENT_AUTHORITY], &ID)
}
