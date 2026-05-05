/// Accounts:
/// 0. authority     — signer, writable (payer)
/// 1. coverage_pool — writable, PDA [b"coverage_pool"], created here
/// 2. usdc_vault    — writable, pre-allocated token account (165 bytes, owner=SPL_TOKEN)
/// 3. usdc_mint     — readonly
/// 4. system_program
/// 5. token_program
/// 6. rent sysvar   — unused but kept for wire compatibility
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    constants::{USDC_DEVNET, USDC_MAINNET},
    error::PactError,
    pda::{derive_coverage_pool, SEED_COVERAGE_POOL},
    state::CoveragePool,
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{initialize_account3, SPL_TOKEN_PROGRAM_ID},
};
use pinocchio::cpi::Seed;

const ACCOUNT_COUNT: usize = 7;

pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let authority = &accounts[0];
    let pool = &accounts[1];
    let vault = &accounts[2];
    let mint = &accounts[3];
    let system_program = &accounts[4];
    let token_program = &accounts[5];

    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority.is_writable() || !pool.is_writable() || !vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    if mint.address() != &USDC_MAINNET && mint.address() != &USDC_DEVNET {
        return Err(PactError::EndpointNotFound.into());
    }

    let (expected_pool, bump) = derive_coverage_pool();
    if pool.address() != &expected_pool {
        return Err(ProgramError::InvalidSeeds);
    }
    if !pool.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Allocate pool account via System CPI
    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(CoveragePool::LEN)?;
    let bump_seed = [bump];
    let signer_seeds: [Seed; 2] = [
        Seed::from(SEED_COVERAGE_POOL),
        Seed::from(&bump_seed[..]),
    ];
    create_account(
        authority,
        pool,
        lamports,
        CoveragePool::LEN as u64,
        &crate::ID,
        &signer_seeds,
    )?;

    // Allocate vault token account (pre-allocated by caller with SPL token space)
    // The vault must already be allocated; we just initialize it
    initialize_account3(vault, mint, pool.address())?;

    // Write initial CoveragePool state
    let mut data = pool.try_borrow_mut()?;
    let state: &mut CoveragePool = bytemuck::from_bytes_mut(&mut data[..CoveragePool::LEN]);
    state.bump = bump;
    state.authority = *authority.address();
    state.usdc_mint = *mint.address();
    state.usdc_vault = *vault.address();
    state.total_deposits = 0;
    state.total_premiums = 0;
    state.total_refunds = 0;
    state.current_balance = 0;
    state.created_at = Clock::get()?.unix_timestamp;

    Ok(())
}
