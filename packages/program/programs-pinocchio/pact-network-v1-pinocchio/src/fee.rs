//! Shared helpers for parsing and validating fee_recipient arrays.

use pinocchio::error::ProgramError;

use crate::{
    constants::{ABSOLUTE_FEE_BPS_CAP, MAX_FEE_RECIPIENTS},
    error::PactError,
    state::{FeeRecipient, FeeRecipientKind},
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
