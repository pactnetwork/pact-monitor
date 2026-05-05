/// update_fee_recipients — pool-authority-only atomic replace of an
/// endpoint's fee_recipients array.
///
/// Accounts:
///   0. authority         — signer (must equal ProtocolConfig.authority)
///   1. protocol_config   — readonly
///   2. treasury          — readonly (used to substitute Treasury kind dest)
///   3. endpoint_config   — writable
///
/// Data:
///   0-15:  endpoint_slug [u8; 16]
///   16:    fee_recipient_count u8 (0..=8)
///   17..:  count * 48 bytes of FeeRecipient entries
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    constants::MAX_FEE_RECIPIENTS,
    error::PactError,
    fee::{parse_and_validate, substitute_treasury_destination, FEE_RECIPIENT_WIRE_LEN},
    pda::derive_endpoint_config,
    state::{EndpointConfig, ProtocolConfig, Treasury},
};

const ACCOUNT_COUNT: usize = 4;
const HEADER_LEN: usize = 16 + 1;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < HEADER_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let protocol_config = &accounts[1];
    let treasury = &accounts[2];
    let endpoint = &accounts[3];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !endpoint.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let max_total_fee_bps;
    {
        let pc_data = protocol_config.try_borrow()?;
        if pc_data.len() < ProtocolConfig::LEN {
            return Err(PactError::ProtocolConfigNotInitialized.into());
        }
        let pc: &ProtocolConfig = bytemuck::from_bytes(&pc_data[..ProtocolConfig::LEN]);
        if &pc.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
        max_total_fee_bps = pc.max_total_fee_bps;
    }

    let treasury_vault = {
        let t_data = treasury.try_borrow()?;
        if t_data.len() < Treasury::LEN {
            return Err(PactError::TreasuryNotInitialized.into());
        }
        let t: &Treasury = bytemuck::from_bytes(&t_data[..Treasury::LEN]);
        t.usdc_vault
    };

    let slug: [u8; 16] = data[0..16].try_into().unwrap();
    let count = data[16] as usize;
    let body_off = HEADER_LEN;
    let needed = body_off + count * FEE_RECIPIENT_WIRE_LEN;
    if data.len() != needed {
        return Err(ProgramError::InvalidInstructionData);
    }
    if count > MAX_FEE_RECIPIENTS {
        return Err(PactError::FeeRecipientArrayTooLong.into());
    }

    let (mut entries, _sum) = parse_and_validate(&data[body_off..], count, max_total_fee_bps)?;
    substitute_treasury_destination(&mut entries, count, &treasury_vault);

    // Verify endpoint PDA
    let (expected_ep, _) = derive_endpoint_config(&slug);
    if endpoint.address() != &expected_ep {
        return Err(ProgramError::InvalidSeeds);
    }

    let mut ep_data = endpoint.try_borrow_mut()?;
    if ep_data.len() < EndpointConfig::LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let state: &mut EndpointConfig =
        bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);
    state.fee_recipient_count = count as u8;
    state.fee_recipients = entries;
    state.last_updated = Clock::get()?.unix_timestamp;

    Ok(())
}
