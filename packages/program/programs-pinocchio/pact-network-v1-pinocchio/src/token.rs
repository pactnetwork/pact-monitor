use pinocchio::{
    account::AccountView,
    cpi::{invoke, invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    ProgramResult,
};
use solana_address::Address;

pub const SPL_TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub const SPL_TOKEN_ACCOUNT_LEN: u64 = 165;

const INITIALIZE_ACCOUNT3_DISC: u8 = 18;
const INITIALIZE_ACCOUNT3_DATA_LEN: usize = 1 + 32;
const TRANSFER_DISC: u8 = 3;
const TRANSFER_DATA_LEN: usize = 1 + 8;

/// SPL-Token `Account` field offsets (165-byte layout). Used to read the
/// `mint` field and `delegate` option without depending on `spl-token`.
pub const TOKEN_ACCOUNT_MINT_OFFSET: usize = 0;
pub const TOKEN_ACCOUNT_OWNER_OFFSET: usize = 32;
pub const TOKEN_ACCOUNT_AMOUNT_OFFSET: usize = 64;
pub const TOKEN_ACCOUNT_STATE_OFFSET: usize = 108;

/// CPI: SPL-Token InitializeAccount3 (binds mint + owner on pre-allocated account).
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

/// CPI: SPL-Token Transfer, user-authority variant (user signs outer tx).
#[inline]
pub fn transfer_user_signed(
    source: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; TRANSFER_DATA_LEN];
    data[0] = TRANSFER_DISC;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let accounts = [
        InstructionAccount::new(source.address(), true, false),
        InstructionAccount::new(destination.address(), true, false),
        InstructionAccount::new(authority.address(), false, true),
    ];

    let instruction = InstructionView {
        program_id: &SPL_TOKEN_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    invoke::<3>(&instruction, &[source, destination, authority])
}

/// CPI: SPL-Token Transfer, PDA-authority variant (PDA signs via signer seeds).
///
/// Used for both:
/// - Pool-vault out (CoveragePool PDA signs to fan out fees / refunds).
/// - Premium pull from agent ATA when `authority` is the SettlementAuthority
///   PDA acting as the agent's pre-approved delegate. The `delegate` field
///   on the source token account must equal `authority.address()` and the
///   delegated amount must cover `amount`; SPL Token enforces both.
#[inline]
pub fn transfer_pda_signed(
    source: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    amount: u64,
    signer_seeds: &[Seed],
) -> ProgramResult {
    let mut data = [0u8; TRANSFER_DATA_LEN];
    data[0] = TRANSFER_DISC;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let accounts = [
        InstructionAccount::new(source.address(), true, false),
        InstructionAccount::new(destination.address(), true, false),
        InstructionAccount::new(authority.address(), false, true),
    ];

    let instruction = InstructionView {
        program_id: &SPL_TOKEN_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    let signer = Signer::from(signer_seeds);
    invoke_signed::<3>(&instruction, &[source, destination, authority], &[signer])
}

/// Read the `mint` field from a 165-byte SPL token account buffer. Returns
/// the 32-byte mint pubkey or `None` if the buffer is too short / not
/// initialised.
#[inline]
pub fn read_token_account_mint(data: &[u8]) -> Option<Address> {
    if data.len() < SPL_TOKEN_ACCOUNT_LEN as usize {
        return None;
    }
    if data[TOKEN_ACCOUNT_STATE_OFFSET] != 1 {
        return None;
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(
        &data[TOKEN_ACCOUNT_MINT_OFFSET..TOKEN_ACCOUNT_MINT_OFFSET + 32],
    );
    Some(Address::new_from_array(bytes))
}
