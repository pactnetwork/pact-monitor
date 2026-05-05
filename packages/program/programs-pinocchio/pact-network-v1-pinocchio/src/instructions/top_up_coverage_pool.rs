/// top_up_coverage_pool — top up a per-endpoint pool from the pool authority's
/// USDC ATA.
///
/// Accounts:
///   0. authority       — signer (must equal coverage_pool.authority)
///   1. coverage_pool   — writable PDA [b"coverage_pool", slug]
///   2. authority_ata   — writable (source)
///   3. pool_vault      — writable (destination)
///   4. token_program
///
/// Data layout (24 bytes):
///   0-15:  endpoint_slug [u8; 16]
///   16-23: amount u64 LE
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::derive_coverage_pool,
    state::CoveragePool,
    token::{transfer_user_signed, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 5;
const ARGS_LEN: usize = 16 + 8;

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

    let slug: [u8; 16] = data[0..16].try_into().unwrap();
    let amount = u64::from_le_bytes(data[16..24].try_into().unwrap());

    let (expected_pool, _) = derive_coverage_pool(&slug);
    if pool.address() != &expected_pool {
        return Err(ProgramError::InvalidSeeds);
    }

    {
        let pool_data = pool.try_borrow()?;
        if pool_data.len() < CoveragePool::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let state: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
        if &state.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
        if &state.usdc_vault != pool_vault.address() {
            return Err(ProgramError::InvalidAccountData);
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
