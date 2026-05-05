/// Accounts:
/// 0. owner          — signer
/// 1. agent_wallet   — writable PDA
/// 2. owner_ata      — writable (source, owned by owner)
/// 3. wallet_vault   — writable (destination, owned by agent_wallet PDA)
/// 4. token_program
///
/// Data: 8 bytes — amount u64 LE
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    ProgramResult,
};

use crate::{
    constants::MAX_DEPOSIT_LAMPORTS,
    error::PactError,
    state::AgentWallet,
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

    let owner = &accounts[0];
    let wallet = &accounts[1];
    let owner_ata = &accounts[2];
    let wallet_vault = &accounts[3];
    let token_program = &accounts[4];

    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !wallet.is_writable() || !owner_ata.is_writable() || !wallet_vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());

    // Verify owner matches wallet
    {
        let aw_data = wallet.try_borrow()?;
        if aw_data.len() < AgentWallet::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let state: &AgentWallet = bytemuck::from_bytes(&aw_data[..AgentWallet::LEN]);
        if &state.owner != owner.address() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        // Check deposit cap: balance + amount must not exceed MAX_DEPOSIT_LAMPORTS
        let new_balance = state
            .balance
            .checked_add(amount)
            .ok_or(PactError::ArithmeticOverflow)?;
        if new_balance > MAX_DEPOSIT_LAMPORTS {
            return Err(PactError::DepositCapExceeded.into());
        }
    }

    // CPI: transfer from owner ATA → wallet vault
    transfer_user_signed(owner_ata, wallet_vault, owner, amount)?;

    // Update state
    let mut aw_data = wallet.try_borrow_mut()?;
    let state: &mut AgentWallet = bytemuck::from_bytes_mut(&mut aw_data[..AgentWallet::LEN]);
    state.balance = state
        .balance
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    state.total_deposits = state
        .total_deposits
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;

    Ok(())
}
