/// initialize_treasury — singleton Treasury PDA + USDC vault.
///
/// Accounts:
///   0. authority         — signer, writable (payer; must equal
///                          ProtocolConfig.authority)
///   1. protocol_config   — readonly, must already be initialized
///   2. treasury          — writable PDA [b"treasury"], created here
///   3. treasury_vault    — writable, pre-allocated 165-byte token account
///                          (owner=SPL_TOKEN_PROGRAM_ID); will be initialized
///                          here via InitializeAccount3 with owner = treasury PDA
///   4. usdc_mint         — readonly
///   5. system_program
///   6. token_program
///
/// Data: empty (no args).
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::{derive_treasury, verify_protocol_config, SEED_TREASURY},
    state::{ProtocolConfig, Treasury},
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{initialize_account3, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 7;

pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let authority = &accounts[0];
    let protocol_config = &accounts[1];
    let treasury = &accounts[2];
    let vault = &accounts[3];
    let mint = &accounts[4];
    let system_program = &accounts[5];
    let token_program = &accounts[6];

    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority.is_writable() || !treasury.is_writable() || !vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // SECURITY: verify ProtocolConfig is the canonical PDA + program-owned
    // BEFORE reading any field off it. (codex 2026-05-05: privilege-escalation
    // class — without these checks an attacker could pass a fake config with
    // their own authority slot.)
    verify_protocol_config(protocol_config)?;

    // ProtocolConfig must exist and authority must match.
    {
        let pc_data = protocol_config.try_borrow()?;
        if pc_data.len() < ProtocolConfig::LEN {
            return Err(PactError::ProtocolConfigNotInitialized.into());
        }
        let pc: &ProtocolConfig = bytemuck::from_bytes(&pc_data[..ProtocolConfig::LEN]);
        if &pc.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
        if &pc.usdc_mint != mint.address() {
            return Err(PactError::FeeRecipientInvalidUsdcMint.into());
        }
    }

    let (expected, bump) = derive_treasury();
    if treasury.address() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    if !treasury.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(Treasury::LEN)?;
    let bump_seed = [bump];
    let signer_seeds: [Seed; 2] = [
        Seed::from(SEED_TREASURY),
        Seed::from(&bump_seed[..]),
    ];
    create_account(
        authority,
        treasury,
        lamports,
        Treasury::LEN as u64,
        &crate::ID,
        &signer_seeds,
    )?;

    // Bind the pre-allocated vault token account to mint + treasury PDA.
    initialize_account3(vault, mint, treasury.address())?;

    let mut t_data = treasury.try_borrow_mut()?;
    let state: &mut Treasury = bytemuck::from_bytes_mut(&mut t_data[..Treasury::LEN]);
    state.bump = bump;
    state._padding0 = [0; 7];
    state.authority = *authority.address();
    state.usdc_vault = *vault.address();
    state.set_at = Clock::get()?.unix_timestamp;

    Ok(())
}
