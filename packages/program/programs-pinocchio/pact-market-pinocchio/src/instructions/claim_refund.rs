/// claim_refund — agent sweeps refunded USDC from AgentWallet vault to their own ATA.
///
/// Capped at total_refunds_received - total_refunds_claimed (not balance, to preserve
/// the 24h cooldown invariant on voluntarily-deposited funds).
///
/// Accounts:
/// 0. owner          — signer
/// 1. agent_wallet   — writable PDA
/// 2. wallet_vault   — writable (source, owned by agent_wallet PDA)
/// 3. owner_ata      — writable (destination)
/// 4. token_program
///
/// Data: 8 bytes — amount u64 LE
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::SEED_AGENT_WALLET,
    state::AgentWallet,
    token::{transfer_pda_signed, SPL_TOKEN_PROGRAM_ID},
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

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());

    let bump;
    let owner_key_bytes: [u8; 32];
    {
        let aw_data = wallet.try_borrow()?;
        if aw_data.len() < AgentWallet::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let state: &AgentWallet = bytemuck::from_bytes(&aw_data[..AgentWallet::LEN]);
        if &state.owner != owner.address() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let claimable = state
            .total_refunds_received
            .checked_sub(state.total_refunds_claimed)
            .unwrap_or(0);
        if amount > claimable {
            return Err(PactError::InsufficientBalance.into());
        }
        bump = state.bump;
        owner_key_bytes = state.owner.as_ref().try_into().unwrap();
    }

    // CPI: wallet vault → owner ATA, signed by wallet PDA
    let bump_seed = [bump];
    let signer_seeds: [Seed; 3] = [
        Seed::from(SEED_AGENT_WALLET),
        Seed::from(&owner_key_bytes[..]),
        Seed::from(&bump_seed[..]),
    ];
    transfer_pda_signed(wallet_vault, owner_ata, wallet, amount, &signer_seeds)?;

    // Update state
    let mut aw_data = wallet.try_borrow_mut()?;
    let state: &mut AgentWallet = bytemuck::from_bytes_mut(&mut aw_data[..AgentWallet::LEN]);
    state.total_refunds_claimed = state
        .total_refunds_claimed
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    state.balance = state
        .balance
        .checked_sub(amount)
        .ok_or(PactError::ArithmeticOverflow)?;

    Ok(())
}
