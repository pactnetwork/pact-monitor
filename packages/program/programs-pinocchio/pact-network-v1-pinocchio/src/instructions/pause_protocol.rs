/// pause_protocol — flip the global kill-switch byte on ProtocolConfig.
///
/// This is the single-tx halt path for mainnet operations: when set, every
/// `settle_batch` invocation returns `PactError::ProtocolPaused` before any
/// per-event processing or token transfer. Cleared by calling this same
/// instruction with `paused = 0`. Authority-only.
///
/// Accounts:
///   0. authority         — signer; must equal ProtocolConfig.authority
///   1. protocol_config   — writable; canonical [b"protocol_config"] PDA,
///                          program-owned (verified via verify_protocol_config)
///
/// Data: 1 byte — 0 = unpause, 1 = pause. Any other byte value is accepted
/// and stored as-is; the on-chain settle guard treats `paused != 0` as
/// engaged. Off-chain operators should always send 0 or 1.
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::verify_protocol_config,
    state::ProtocolConfig,
};

const ACCOUNT_COUNT: usize = 2;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() != 1 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let protocol_config = &accounts[1];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !protocol_config.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // SECURITY: verify ProtocolConfig is the canonical PDA + program-owned
    // BEFORE reading or writing any field. Same pattern as the rest of the
    // privileged handlers (codex 2026-05-05 review fix).
    verify_protocol_config(protocol_config)?;

    let mut pc_data = protocol_config.try_borrow_mut()?;
    if pc_data.len() < ProtocolConfig::LEN {
        return Err(PactError::ProtocolConfigNotInitialized.into());
    }
    let state: &mut ProtocolConfig =
        bytemuck::from_bytes_mut(&mut pc_data[..ProtocolConfig::LEN]);
    if &state.authority != authority.address() {
        return Err(PactError::UnauthorizedAuthority.into());
    }
    state.paused = data[0];

    Ok(())
}
