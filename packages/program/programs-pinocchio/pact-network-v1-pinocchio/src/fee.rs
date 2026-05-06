//! Shared helpers for parsing and validating fee_recipient arrays.

use pinocchio::{account::AccountView, error::ProgramError};
use solana_address::Address;

use crate::{
    constants::{ABSOLUTE_FEE_BPS_CAP, MAX_FEE_RECIPIENTS},
    error::PactError,
    state::{FeeRecipient, FeeRecipientKind},
    token::{
        SPL_TOKEN_ACCOUNT_LEN, SPL_TOKEN_PROGRAM_ID, TOKEN_ACCOUNT_MINT_OFFSET,
        TOKEN_ACCOUNT_STATE_OFFSET,
    },
};

pub const FEE_RECIPIENT_WIRE_LEN: usize = FeeRecipient::LEN; // 48

/// Decode a 48-byte fee recipient entry from raw bytes.
#[inline]
pub fn decode_entry(raw: &[u8]) -> Result<FeeRecipient, ProgramError> {
    if raw.len() < FEE_RECIPIENT_WIRE_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let kind_byte = raw[0];
    if FeeRecipientKind::from_u8(kind_byte).is_none() {
        return Err(PactError::InvalidFeeRecipientKind.into());
    }
    let mut dest = [0u8; 32];
    dest.copy_from_slice(&raw[8..40]);
    let bps = u16::from_le_bytes(raw[40..42].try_into().unwrap());
    Ok(FeeRecipient {
        kind: kind_byte,
        _pad0: [0; 7],
        destination: solana_address::Address::new_from_array(dest),
        bps,
        _pad1: [0; 6],
    })
}

/// Decode + validate up to MAX_FEE_RECIPIENTS entries from a flat byte buffer.
///
/// Returns `(entries, sum_bps)`. Validates: count, kind discriminant,
/// per-entry bps cap, sum, multiple-treasury rule, and duplicate destination.
pub fn parse_and_validate(
    bytes: &[u8],
    count: usize,
    max_total_fee_bps: u16,
) -> Result<([FeeRecipient; MAX_FEE_RECIPIENTS], u32), ProgramError> {
    if count > MAX_FEE_RECIPIENTS {
        return Err(PactError::FeeRecipientArrayTooLong.into());
    }
    if bytes.len() < count * FEE_RECIPIENT_WIRE_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let mut entries: [FeeRecipient; MAX_FEE_RECIPIENTS] =
        [FeeRecipient::ZERO; MAX_FEE_RECIPIENTS];
    let mut sum_bps: u32 = 0;
    let mut treasury_seen = false;

    for i in 0..count {
        let off = i * FEE_RECIPIENT_WIRE_LEN;
        let entry = decode_entry(&bytes[off..off + FEE_RECIPIENT_WIRE_LEN])?;
        if entry.bps > ABSOLUTE_FEE_BPS_CAP {
            return Err(PactError::FeeBpsExceedsCap.into());
        }
        if entry.kind == FeeRecipientKind::Treasury as u8 {
            if treasury_seen {
                return Err(PactError::MultipleTreasuryRecipients.into());
            }
            treasury_seen = true;
        }
        for j in 0..i {
            if entries[j].destination.as_ref() == entry.destination.as_ref() {
                return Err(PactError::FeeRecipientDuplicateDestination.into());
            }
        }
        sum_bps = sum_bps
            .checked_add(entry.bps as u32)
            .ok_or(PactError::ArithmeticOverflow)?;
        entries[i] = entry;
    }
    if sum_bps > ABSOLUTE_FEE_BPS_CAP as u32 {
        return Err(PactError::FeeBpsSumOver10k.into());
    }
    if sum_bps > max_total_fee_bps as u32 {
        return Err(PactError::FeeBpsExceedsCap.into());
    }
    Ok((entries, sum_bps))
}

/// Substitute the Treasury entry's destination with the actual Treasury USDC
/// vault. The on-wire destination for a Treasury entry is unused (we route
/// to the singleton vault); this normalises it to the canonical pubkey at
/// register time so settle_batch can compare against the runtime account.
pub fn substitute_treasury_destination(
    entries: &mut [FeeRecipient; MAX_FEE_RECIPIENTS],
    count: usize,
    treasury_usdc_vault: &solana_address::Address,
) {
    for i in 0..count {
        if entries[i].kind == FeeRecipientKind::Treasury as u8 {
            entries[i].destination = *treasury_usdc_vault;
        }
    }
}

// ---------------------------------------------------------------------------
// Post-substitution validation (codex 2026-05-05 review fix)
//
// `parse_and_validate` runs BEFORE Treasury kind gets its real destination
// substituted in. That means a caller-supplied AffiliateAta with the same
// pubkey as the Treasury vault would slip past the dup check. The helpers
// below run AFTER substitution and additionally require:
//   - exactly one Treasury entry,
//   - Treasury bps > 0,
//   - no duplicate destinations once Treasury has its real vault address,
//   - each AffiliateAta destination is a real, initialised SPL Token account
//     of the protocol USDC mint.
// ---------------------------------------------------------------------------

/// Run after `substitute_treasury_destination`. Enforces:
/// - exactly one Treasury entry,
/// - Treasury entry bps > 0,
/// - no duplicate destinations across the whole array (now Treasury holds the
///   canonical vault address, so an attacker cannot smuggle a duplicate via
///   the unused Treasury wire-destination field).
pub fn validate_post_substitution(
    entries: &[FeeRecipient; MAX_FEE_RECIPIENTS],
    count: usize,
) -> Result<(), ProgramError> {
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
        // parse_and_validate also guards this, but be defensive.
        return Err(PactError::MultipleTreasuryRecipients.into());
    }
    if treasury_bps == 0 {
        return Err(PactError::TreasuryBpsZero.into());
    }
    // Duplicate detection AFTER substitution. Treasury's destination is now
    // the real vault, so this catches attacker-supplied AffiliateAta pointing
    // at the Treasury vault.
    for i in 0..count {
        for j in 0..i {
            if entries[i].destination.as_ref() == entries[j].destination.as_ref() {
                return Err(PactError::FeeRecipientDuplicateDestination.into());
            }
        }
    }
    Ok(())
}

/// Validate that every AffiliateAta entry's destination is a real SPL Token
/// account on the protocol USDC mint. `affiliate_atas` is the slice of
/// AccountViews supplied by the caller, in the same order as the AffiliateAta
/// entries appear in `entries[..count]`.
///
/// Per-account checks:
/// - account is owned by SPL Token program,
/// - account data is exactly `SPL_TOKEN_ACCOUNT_LEN` (165) bytes,
/// - state byte at offset 108 == 1 (initialised),
/// - mint at offset 0..32 == `protocol_usdc_mint`,
/// - account address matches the entry's stored destination (so the caller
///   can't pass mismatched account-list ordering).
pub fn validate_affiliate_atas(
    entries: &[FeeRecipient; MAX_FEE_RECIPIENTS],
    count: usize,
    affiliate_atas: &[&AccountView],
    protocol_usdc_mint: &Address,
) -> Result<(), ProgramError> {
    let mut ata_cursor = 0usize;
    for i in 0..count {
        if entries[i].kind != FeeRecipientKind::AffiliateAta as u8 {
            continue;
        }
        if ata_cursor >= affiliate_atas.len() {
            // Caller didn't pass enough ATA accounts to validate.
            return Err(PactError::InvalidAffiliateAta.into());
        }
        let ata = affiliate_atas[ata_cursor];
        ata_cursor += 1;

        // Address must match the stored destination.
        if ata.address() != &entries[i].destination {
            return Err(PactError::InvalidAffiliateAta.into());
        }
        // Owner must be SPL Token program.
        if !ata.owned_by(&SPL_TOKEN_PROGRAM_ID) {
            return Err(PactError::InvalidAffiliateAta.into());
        }
        let data = ata.try_borrow().map_err(|_| PactError::InvalidAffiliateAta)?;
        if data.len() < SPL_TOKEN_ACCOUNT_LEN as usize {
            return Err(PactError::InvalidAffiliateAta.into());
        }
        // State byte must be Initialized (1).
        if data[TOKEN_ACCOUNT_STATE_OFFSET] != 1 {
            return Err(PactError::InvalidAffiliateAta.into());
        }
        // Mint must equal protocol USDC mint.
        if &data[TOKEN_ACCOUNT_MINT_OFFSET..TOKEN_ACCOUNT_MINT_OFFSET + 32]
            != protocol_usdc_mint.as_ref()
        {
            return Err(PactError::InvalidAffiliateAta.into());
        }
    }
    Ok(())
}
