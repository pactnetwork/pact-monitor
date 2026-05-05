/// Accounts:
/// 0. authority       — signer (must match coverage_pool.authority)
/// 1. coverage_pool   — writable PDA
/// 2. authority_ata   — writable (source)
/// 3. pool_vault      — writable (destination)
/// 4. token_program
///
/// Data: 8 bytes — amount u64 LE
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    ProgramResult,
};

use crate::{
    error::PactError,
    state::CoveragePool,
    token::{transfer_user_signed, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 5;
const ARGS_LEN: usize = 8;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() != ARGS_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let pool = &accounts[1];
    let authority_ata = &accounts[2];
    let pool_vault = &accounts[3];
    let token_program = &accounts[4];

    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !pool.is_writable() || !authority_ata.is_writable() || !pool_vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());

    {
        let pool_data = pool.try_borrow()?;
        if pool_data.len() < CoveragePool::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let state: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
        if &state.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
    }

    transfer_user_signed(authority_ata, pool_vault, authority, amount)?;

    let mut pool_data = pool.try_borrow_mut()?;
    let state: &mut CoveragePool = bytemuck::from_bytes_mut(&mut pool_data[..CoveragePool::LEN]);
    state.current_balance = state
        .current_balance
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    state.total_deposits = state
        .total_deposits
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;

    Ok(())
}
