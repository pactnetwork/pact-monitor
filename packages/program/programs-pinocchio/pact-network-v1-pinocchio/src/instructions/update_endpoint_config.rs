/// update_endpoint_config — pool-authority-only updates to mutable
/// EndpointConfig fields.
///
/// Accounts:
///   0. authority         — signer (must equal ProtocolConfig.authority)
///   1. protocol_config   — readonly
///   2. endpoint_config   — writable
///
/// Data layout — 5 optional fields, each prefixed with 1-byte presence flag:
///   [present:u8][flat_premium_lamports:u64]  — 9 bytes
///   [present:u8][percent_bps:u16]            — 3 bytes
///   [present:u8][sla_latency_ms:u32]         — 5 bytes
///   [present:u8][imputed_cost_lamports:u64]  — 9 bytes
///   [present:u8][exposure_cap:u64]           — 9 bytes
///   Total: 35 bytes
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    state::{EndpointConfig, ProtocolConfig},
};

const ACCOUNT_COUNT: usize = 3;
const ARGS_LEN: usize = 9 + 3 + 5 + 9 + 9;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() != ARGS_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let protocol_config = &accounts[1];
    let endpoint = &accounts[2];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !endpoint.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    {
        let pc_data = protocol_config.try_borrow()?;
        if pc_data.len() < ProtocolConfig::LEN {
            return Err(PactError::ProtocolConfigNotInitialized.into());
        }
        let pc: &ProtocolConfig = bytemuck::from_bytes(&pc_data[..ProtocolConfig::LEN]);
        if &pc.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
    }

    let mut ep_data = endpoint.try_borrow_mut()?;
    if ep_data.len() < EndpointConfig::LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let state: &mut EndpointConfig = bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);

    let mut offset = 0usize;

    // flat_premium_lamports
    if data[offset] == 1 {
        state.flat_premium_lamports =
            u64::from_le_bytes(data[offset + 1..offset + 9].try_into().unwrap());
    }
    offset += 9;

    // percent_bps
    if data[offset] == 1 {
        state.percent_bps =
            u16::from_le_bytes(data[offset + 1..offset + 3].try_into().unwrap());
    }
    offset += 3;

    // sla_latency_ms
    if data[offset] == 1 {
        state.sla_latency_ms =
            u32::from_le_bytes(data[offset + 1..offset + 5].try_into().unwrap());
    }
    offset += 5;

    // imputed_cost_lamports
    if data[offset] == 1 {
        state.imputed_cost_lamports =
            u64::from_le_bytes(data[offset + 1..offset + 9].try_into().unwrap());
    }
    offset += 9;

    // exposure_cap_per_hour_lamports
    if data[offset] == 1 {
        state.exposure_cap_per_hour_lamports =
            u64::from_le_bytes(data[offset + 1..offset + 9].try_into().unwrap());
    }

    state.last_updated = Clock::get()?.unix_timestamp;

    Ok(())
}
