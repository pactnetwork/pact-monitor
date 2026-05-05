/// Accounts:
/// 0. owner          — signer
/// 1. agent_wallet   — writable PDA
///
/// Data: 8 bytes — amount u64 LE
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    constants::WITHDRAWAL_COOLDOWN_SECS,
    error::PactError,
    state::AgentWallet,
};

const ACCOUNT_COUNT: usize = 2;
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

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !wallet.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let now = Clock::get()?.unix_timestamp;

    let mut aw_data = wallet.try_borrow_mut()?;
    if aw_data.len() < AgentWallet::LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let state: &mut AgentWallet = bytemuck::from_bytes_mut(&mut aw_data[..AgentWallet::LEN]);

    if &state.owner != owner.address() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // Block if there's an existing pending withdrawal with active cooldown
    if state.pending_withdrawal > 0 && now < state.withdrawal_unlock_at {
        return Err(PactError::WithdrawalCooldownActive.into());
    }
    if amount > state.balance {
        return Err(PactError::InsufficientBalance.into());
    }

    state.pending_withdrawal = amount;
    state.withdrawal_unlock_at = now
        .checked_add(WITHDRAWAL_COOLDOWN_SECS)
        .ok_or(PactError::ArithmeticOverflow)?;

    Ok(())
}
