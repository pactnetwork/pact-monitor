/// Accounts:
/// 0. authority        — signer, writable (must match coverage_pool.authority)
/// 1. coverage_pool    — readonly
/// 2. endpoint_config  — writable, PDA [b"endpoint", slug], created here
/// 3. system_program
///
/// Data layout (46 bytes):
///   0-15:  slug [u8; 16]
///   16-23: flat_premium_lamports u64
///   24-25: percent_bps u16
///   26-29: sla_latency_ms u32
///   30-37: imputed_cost_lamports u64
///   38-45: exposure_cap_per_hour_lamports u64
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::{derive_endpoint_config, SEED_ENDPOINT},
    state::{CoveragePool, EndpointConfig},
    system::{create_account, SYSTEM_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 4;
const ARGS_LEN: usize = 46;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() != ARGS_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let pool = &accounts[1];
    let endpoint = &accounts[2];
    let system_program = &accounts[3];

    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority.is_writable() || !endpoint.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify caller is pool authority
    {
        let pool_data = pool.try_borrow()?;
        if pool_data.len() < CoveragePool::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let pool_state: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
        if &pool_state.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
    }

    // Parse args
    let slug: [u8; 16] = data[0..16].try_into().unwrap();

    // Validate slug: all bytes must be ASCII printable (0x20-0x7E) or zero pad
    for &b in slug.iter() {
        if b != 0 && (b < 0x20 || b > 0x7E) {
            return Err(PactError::InvalidSlug.into());
        }
    }

    let flat_premium_lamports = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let percent_bps = u16::from_le_bytes(data[24..26].try_into().unwrap());
    let sla_latency_ms = u32::from_le_bytes(data[26..30].try_into().unwrap());
    let imputed_cost_lamports = u64::from_le_bytes(data[30..38].try_into().unwrap());
    let exposure_cap_per_hour_lamports = u64::from_le_bytes(data[38..46].try_into().unwrap());

    let (expected_pda, bump) = derive_endpoint_config(&slug);
    if endpoint.address() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if !endpoint.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(EndpointConfig::LEN)?;
    let bump_seed = [bump];
    let signer_seeds: [Seed; 3] = [
        Seed::from(SEED_ENDPOINT),
        Seed::from(&slug[..]),
        Seed::from(&bump_seed[..]),
    ];
    create_account(
        authority,
        endpoint,
        lamports,
        EndpointConfig::LEN as u64,
        &crate::ID,
        &signer_seeds,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let mut ep_data = endpoint.try_borrow_mut()?;
    let state: &mut EndpointConfig = bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);
    state.bump = bump;
    state.paused = 0;
    state.slug = slug;
    state.flat_premium_lamports = flat_premium_lamports;
    state.percent_bps = percent_bps;
    state.sla_latency_ms = sla_latency_ms;
    state.imputed_cost_lamports = imputed_cost_lamports;
    state.exposure_cap_per_hour_lamports = exposure_cap_per_hour_lamports;
    state.current_period_start = now;
    state.current_period_refunds = 0;
    state.total_calls = 0;
    state.total_breaches = 0;
    state.total_premiums = 0;
    state.total_refunds = 0;
    state.last_updated = now;

    Ok(())
}
