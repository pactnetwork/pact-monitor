/// initialize_protocol_config — singleton ProtocolConfig PDA.
///
/// Accounts:
///   0. authority         — signer, writable (payer + protocol authority)
///   1. protocol_config   — writable PDA [b"protocol_config"], created here
///   2. usdc_mint         — readonly (must be USDC_DEVNET or USDC_MAINNET)
///   3. system_program
///
/// Data layout (variable, capped at 1+1+2+1+8*48 = 389 bytes):
///   0:        max_total_fee_bps_present u8 (0 = use default 3000)
///   1-2:      max_total_fee_bps u16 LE  (read only when above flag = 1)
///   3:        default_fee_recipient_count u8 (0..=8)
///   4..:      `count` * 48 bytes of FeeRecipient entries — same on-chain
///             layout as the embedded array.
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    constants::{ABSOLUTE_FEE_BPS_CAP, DEFAULT_MAX_TOTAL_FEE_BPS, MAX_FEE_RECIPIENTS, USDC_DEVNET, USDC_MAINNET},
    error::PactError,
    pda::{derive_protocol_config, SEED_PROTOCOL_CONFIG},
    state::{FeeRecipient, FeeRecipientKind, ProtocolConfig},
    system::{create_account, SYSTEM_PROGRAM_ID},
};

const FIXED_ACCOUNTS: usize = 4;
const HEADER_LEN: usize = 1 + 2 + 1; // present + max_total + count
const ENTRY_LEN: usize = FeeRecipient::LEN; // 48

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < FIXED_ACCOUNTS {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < HEADER_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let pc_acct = &accounts[1];
    let mint = &accounts[2];
    let system_program = &accounts[3];

    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority.is_writable() || !pc_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if mint.address() != &USDC_MAINNET && mint.address() != &USDC_DEVNET {
        return Err(PactError::FeeRecipientInvalidUsdcMint.into());
    }

    let (expected_pc, bump) = derive_protocol_config();
    if pc_acct.address() != &expected_pc {
        return Err(ProgramError::InvalidSeeds);
    }
    if !pc_acct.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Parse header
    let max_present = data[0];
    let max_total_fee_bps = if max_present == 1 {
        u16::from_le_bytes(data[1..3].try_into().unwrap())
    } else {
        DEFAULT_MAX_TOTAL_FEE_BPS
    };
    let count = data[3] as usize;
    if count > MAX_FEE_RECIPIENTS {
        return Err(PactError::FeeRecipientArrayTooLong.into());
    }
    let expected_len = HEADER_LEN + count * ENTRY_LEN;
    if data.len() != expected_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    if max_total_fee_bps > ABSOLUTE_FEE_BPS_CAP {
        return Err(PactError::FeeBpsExceedsCap.into());
    }

    // Parse + validate recipient entries
    let mut entries: [FeeRecipient; MAX_FEE_RECIPIENTS] = [FeeRecipient::ZERO; MAX_FEE_RECIPIENTS];
    let mut sum_bps: u32 = 0;
    let mut treasury_seen = false;
    for i in 0..count {
        let off = HEADER_LEN + i * ENTRY_LEN;
        let raw = &data[off..off + ENTRY_LEN];
        let kind_byte = raw[0];
        let kind = FeeRecipientKind::from_u8(kind_byte)
            .ok_or(PactError::InvalidFeeRecipientKind)?;
        let mut dest_bytes = [0u8; 32];
        dest_bytes.copy_from_slice(&raw[8..40]);
        let bps = u16::from_le_bytes(raw[40..42].try_into().unwrap());
        if bps as u16 > ABSOLUTE_FEE_BPS_CAP {
            return Err(PactError::FeeBpsExceedsCap.into());
        }
        if kind == FeeRecipientKind::Treasury {
            if treasury_seen {
                return Err(PactError::MultipleTreasuryRecipients.into());
            }
            treasury_seen = true;
        }
        // Duplicate destination check (skip Treasury all-zero placeholder
        // dest comparisons against other zero-placeholder Treasury entries —
        // already excluded by treasury_seen guard above).
        for j in 0..i {
            if entries[j].destination.as_ref() == &dest_bytes[..] {
                return Err(PactError::FeeRecipientDuplicateDestination.into());
            }
        }
        sum_bps = sum_bps
            .checked_add(bps as u32)
            .ok_or(PactError::ArithmeticOverflow)?;
        entries[i].kind = kind_byte;
        entries[i].destination = solana_address::Address::new_from_array(dest_bytes);
        entries[i].bps = bps;
    }
    if sum_bps > ABSOLUTE_FEE_BPS_CAP as u32 {
        return Err(PactError::FeeBpsSumOver10k.into());
    }
    if sum_bps > max_total_fee_bps as u32 {
        return Err(PactError::FeeBpsExceedsCap.into());
    }

    // codex 2026-05-05 review fix: tighten Treasury invariants for the default
    // template. We can't run validate_post_substitution here because Treasury
    // PDA doesn't exist yet (init_treasury runs after init_protocol_config).
    // The rule is therefore: if count > 0, exactly one Treasury entry must be
    // present and its bps must be non-zero. count == 0 is allowed — operators
    // who want every endpoint to declare its own recipients can deploy with
    // empty defaults.
    if count > 0 {
        let mut treasury_count = 0usize;
        let mut treasury_bps: u16 = 0;
        for i in 0..count {
            if entries[i].kind == FeeRecipientKind::Treasury as u8 {
                treasury_count += 1;
                treasury_bps = entries[i].bps;
            }
        }
        if treasury_count == 0 {
            return Err(PactError::MissingTreasuryEntry.into());
        }
        if treasury_count > 1 {
            return Err(PactError::MultipleTreasuryRecipients.into());
        }
        if treasury_bps == 0 {
            return Err(PactError::TreasuryBpsZero.into());
        }
    }

    // Allocate PDA
    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(ProtocolConfig::LEN)?;
    let bump_seed = [bump];
    let signer_seeds: [Seed; 2] = [
        Seed::from(SEED_PROTOCOL_CONFIG),
        Seed::from(&bump_seed[..]),
    ];
    create_account(
        authority,
        pc_acct,
        lamports,
        ProtocolConfig::LEN as u64,
        &crate::ID,
        &signer_seeds,
    )?;

    let mut pc_data = pc_acct.try_borrow_mut()?;
    let state: &mut ProtocolConfig =
        bytemuck::from_bytes_mut(&mut pc_data[..ProtocolConfig::LEN]);
    state.bump = bump;
    state._padding0 = [0; 7];
    state.authority = *authority.address();
    state.usdc_mint = *mint.address();
    state.max_total_fee_bps = max_total_fee_bps;
    state.default_fee_recipient_count = count as u8;
    state._padding1 = [0; 5];
    state.default_fee_recipients = entries;

    Ok(())
}
