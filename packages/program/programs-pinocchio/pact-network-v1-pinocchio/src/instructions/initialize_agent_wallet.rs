/// Accounts:
/// 0. owner         — signer, writable (payer)
/// 1. agent_wallet  — writable, PDA [b"agent_wallet", owner], created here
/// 2. usdc_vault    — writable, pre-allocated token account (165 bytes, owner=SPL_TOKEN)
/// 3. usdc_mint     — readonly
/// 4. system_program
/// 5. token_program
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    pda::{derive_agent_wallet, SEED_AGENT_WALLET},
    state::AgentWallet,
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{initialize_account3, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 6;

pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let owner = &accounts[0];
    let wallet = &accounts[1];
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
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !owner.is_writable() || !wallet.is_writable() || !vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let (expected_pda, bump) = derive_agent_wallet(owner.address());
    if wallet.address() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if !wallet.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(AgentWallet::LEN)?;
    let bump_seed = [bump];
    let signer_seeds: [Seed; 3] = [
        Seed::from(SEED_AGENT_WALLET),
        Seed::from(owner.address().as_ref()),
        Seed::from(&bump_seed[..]),
    ];
    create_account(
        owner,
        wallet,
        lamports,
        AgentWallet::LEN as u64,
        &crate::ID,
        &signer_seeds,
    )?;

    // Initialize vault token account owned by wallet PDA
    initialize_account3(vault, mint, wallet.address())?;

    let mut aw_data = wallet.try_borrow_mut()?;
    let state: &mut AgentWallet = bytemuck::from_bytes_mut(&mut aw_data[..AgentWallet::LEN]);
    state.bump = bump;
    state.owner = *owner.address();
    state.usdc_vault = *vault.address();
    state.balance = 0;
    state.total_deposits = 0;
    state.total_premiums_paid = 0;
    state.total_refunds_received = 0;
    state.total_refunds_claimed = 0;
    state.call_count = 0;
    state.pending_withdrawal = 0;
    state.withdrawal_unlock_at = 0;
    state.created_at = Clock::get()?.unix_timestamp;

    Ok(())
}
