/// Accounts:
/// 0. authority        — signer (must match coverage_pool.authority)
/// 1. coverage_pool    — readonly
/// 2. endpoint_config  — writable
///
/// Data: 1 byte — 0=unpause, 1=pause
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    ProgramResult,
};

use crate::{
    error::PactError,
    state::{CoveragePool, EndpointConfig},
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
    let pool = &accounts[1];
    let endpoint = &accounts[2];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !endpoint.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    {
        let pool_data = pool.try_borrow()?;
        if pool_data.len() < CoveragePool::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let pool_state: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
        if &pool_state.authority != authority.address() {
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
