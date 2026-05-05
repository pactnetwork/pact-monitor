/// pause_endpoint — flip the paused flag on an endpoint.
///
/// Accounts:
///   0. authority         — signer (must equal ProtocolConfig.authority)
///   1. protocol_config   — readonly
///   2. endpoint_config   — writable
///
/// Data: 1 byte — 0=unpause, 1=pause
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    ProgramResult,
};

use crate::{
    error::PactError,
    state::{EndpointConfig, ProtocolConfig},
};

const ACCOUNT_COUNT: usize = 3;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() != 1 {
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
    state.paused = data[0];

    Ok(())
}
