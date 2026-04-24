//! Hand-rolled SPL-Token CPI helpers.
//!
//! We avoid the `pinocchio-token` crate for the same reason `pinocchio-system`
//! is absent (WP-1 post-mortem #2, WP-5 addendum #10): `pinocchio-token`'s
//! published versions depend on pinocchio 0.9 / 0.11, never 0.10 which is our
//! pin. The SPL-Token instruction layout we need (`InitializeAccount3`) is
//! stable, so encoding it directly is smaller than chasing a compatible fork.
//!
//! This module covers only what WP-8's `create_pool` needs: binding an
//! already-System-created token account to `(mint, owner)` via
//! `InitializeAccount3` (discriminant byte 18). No sign-via-PDA is required
//! here — the SPL Token Program reads the owner pubkey from the instruction
//! payload rather than from a signer.

use pinocchio::{
    account::AccountView,
    cpi::invoke,
    instruction::{InstructionAccount, InstructionView},
    ProgramResult,
};
use solana_address::Address;

/// SPL Token Program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const SPL_TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// On-chain size of an SPL-Token `Account`. The Token Program's `Account`
/// state is a fixed 165 bytes (mint 32 + owner 32 + amount 8 + delegate 36 +
/// state 1 + is_native 12 + delegated_amount 8 + close_authority 36).
pub const SPL_TOKEN_ACCOUNT_LEN: u64 = 165;

/// SPL-Token `InitializeAccount3` instruction discriminant. Mirrors the
/// `TokenInstruction::InitializeAccount3 { owner }` variant in
/// `spl-token`'s `instruction.rs` — historically index 18 (0x12).
const INITIALIZE_ACCOUNT3_DISC: u8 = 18;

/// Encoded payload length: 1-byte disc + 32-byte owner pubkey.
const INITIALIZE_ACCOUNT3_DATA_LEN: usize = 1 + 32;

/// CPI into SPL-Token `InitializeAccount3`.
///
/// Binds `account.mint = mint` and `account.owner = owner` on an already-
/// allocated token-account buffer. The account must have been allocated
/// by the System Program with `owner = spl_token::ID` and `space = 165`
/// immediately prior — `create_pool` does this one step up the stack.
///
/// `InitializeAccount3` does not require the account-owner to sign (that's
/// the whole point of the `3` variant vs. the original `InitializeAccount`).
/// The owner is set purely from the instruction payload, so a plain `invoke`
/// without signer seeds is correct.
#[inline]
pub fn initialize_account3(
    account: &AccountView,
    mint: &AccountView,
    owner: &Address,
) -> ProgramResult {
    let mut data = [0u8; INITIALIZE_ACCOUNT3_DATA_LEN];
    data[0] = INITIALIZE_ACCOUNT3_DISC;
    data[1..33].copy_from_slice(owner.as_ref());

    let accounts = [
        InstructionAccount::new(account.address(), true, false),
        InstructionAccount::new(mint.address(), false, false),
    ];

    let instruction = InstructionView {
        program_id: &SPL_TOKEN_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    invoke::<2>(&instruction, &[account, mint])
}
