/// Accounts:
///   0. authority              — signer, writable (must equal ProtocolConfig.authority)
///   1. protocol_config        — readonly, must already be initialized
///   2. settlement_authority   — writable, PDA [b"settlement_authority"], created here
///   3. system_program
///
/// Data: 32 bytes — settler signer pubkey.
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use solana_address::Address;

use crate::{
    error::PactError,
    pda::{derive_settlement_authority, SEED_SETTLEMENT_AUTHORITY},
    state::{ProtocolConfig, SettlementAuthority},
    system::{create_account, SYSTEM_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 4;
const ARGS_LEN: usize = 32;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() != ARGS_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let protocol_config = &accounts[1];
    let settlement_auth = &accounts[2];
    let system_program = &accounts[3];

    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority.is_writable() || !settlement_auth.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    {
        let pc_data = protocol_config.try_borrow()?;
        if pc_data.len() < ProtocolConfig::LEN {
            return Err(PactError::ProtocolConfigNotInitialized.into());
        }
        let pc: &ProtocolConfig = bytemuck::from_bytes(&pc_data[..ProtocolConfig::LEN]);
        if &pc.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
    }

    let (expected_pda, bump) = derive_settlement_authority();
    if settlement_auth.address() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if !settlement_auth.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let signer_pubkey = Address::new_from_array(data[0..32].try_into().unwrap());

    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(SettlementAuthority::LEN)?;
    let bump_seed = [bump];
    let signer_seeds: [Seed; 2] = [
        Seed::from(SEED_SETTLEMENT_AUTHORITY),
        Seed::from(&bump_seed[..]),
    ];
    create_account(
        authority,
        settlement_auth,
        lamports,
        SettlementAuthority::LEN as u64,
        &crate::ID,
        &signer_seeds,
    )?;

    let mut sa_data = settlement_auth.try_borrow_mut()?;
    let state: &mut SettlementAuthority =
        bytemuck::from_bytes_mut(&mut sa_data[..SettlementAuthority::LEN]);
    state.bump = bump;
    state._padding0 = [0; 7];
    state.signer = signer_pubkey;
    state.set_at = Clock::get()?.unix_timestamp;

    Ok(())
}
