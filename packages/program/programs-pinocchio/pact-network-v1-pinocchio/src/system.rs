use pinocchio::{
    account::AccountView,
    cpi::{invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    ProgramResult,
};
use solana_address::Address;

pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0u8; 32]);

const CREATE_ACCOUNT_DATA_LEN: usize = 4 + 8 + 8 + 32;

pub fn create_account(
    from: &AccountView,
    to: &AccountView,
    lamports: u64,
    space: u64,
    owner: &Address,
    signer_seeds: &[Seed],
) -> ProgramResult {
    let mut data = [0u8; CREATE_ACCOUNT_DATA_LEN];
    data[0..4].copy_from_slice(&0u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&space.to_le_bytes());
    data[20..52].copy_from_slice(owner.as_ref());

    let accounts = [
        InstructionAccount::new(from.address(), true, true),
        InstructionAccount::new(to.address(), true, true),
    ];

    let instruction = InstructionView {
        program_id: &SYSTEM_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    let signer = Signer::from(signer_seeds);
    invoke_signed::<2>(&instruction, &[from, to], &[signer])
}
