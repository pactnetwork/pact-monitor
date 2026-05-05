/// Accounts:
/// 0. owner          — signer
/// 1. agent_wallet   — writable PDA
/// 2. wallet_vault   — writable (source, owned by agent_wallet PDA)
/// 3. owner_ata      — writable (destination)
/// 4. token_program
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::SEED_AGENT_WALLET,
    state::AgentWallet,
    token::{transfer_pda_signed, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 5;

pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let owner = &accounts[0];
    let wallet = &accounts[1];
    let wallet_vault = &accounts[2];
    let owner_ata = &accounts[3];
    let token_program = &accounts[4];

    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !wallet.is_writable() || !wallet_vault.is_writable() || !owner_ata.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let now = Clock::get()?.unix_timestamp;

    let amount;
    let bump;
    {
        let aw_data = wallet.try_borrow()?;
        if aw_data.len() < AgentWallet::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let state: &AgentWallet = bytemuck::from_bytes(&aw_data[..AgentWallet::LEN]);
        if &state.owner != owner.address() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if state.pending_withdrawal == 0 {
            return Err(PactError::NoPendingWithdrawal.into());
        }
        if now < state.withdrawal_unlock_at {
            return Err(PactError::WithdrawalCooldownActive.into());
        }
        if state.pending_withdrawal > state.balance {
            return Err(PactError::InsufficientBalance.into());
        }
        amount = state.pending_withdrawal;
        bump = state.bump;
    }

    // CPI: wallet vault → owner ATA, signed by wallet PDA
    let bump_seed = [bump];
    let signer_seeds: [Seed; 3] = [
        Seed::from(SEED_AGENT_WALLET),
        Seed::from(owner.address().as_ref()),
        Seed::from(&bump_seed[..]),
    ];
    transfer_pda_signed(wallet_vault, owner_ata, wallet, amount, &signer_seeds)?;

    // Update state
    let mut aw_data = wallet.try_borrow_mut()?;
    let state: &mut AgentWallet = bytemuck::from_bytes_mut(&mut aw_data[..AgentWallet::LEN]);
    state.balance = state
        .balance
        .checked_sub(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    state.pending_withdrawal = 0;
    state.withdrawal_unlock_at = 0;

    Ok(())
}
