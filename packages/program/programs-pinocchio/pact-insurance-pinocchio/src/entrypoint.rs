use pinocchio::{account::AccountView, address::Address, error::ProgramError, ProgramResult};

use crate::discriminator::Discriminator;

pub fn process_instruction(
    _program_id: &Address,
    _accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (disc_byte, _rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    let disc = Discriminator::try_from(*disc_byte)?;

    match disc {
        Discriminator::InitializeProtocol
        | Discriminator::UpdateConfig
        | Discriminator::UpdateOracle
        | Discriminator::CreatePool
        | Discriminator::Deposit
        | Discriminator::EnableInsurance
        | Discriminator::DisablePolicy
        | Discriminator::SettlePremium
        | Discriminator::Withdraw
        | Discriminator::UpdateRates
        | Discriminator::SubmitClaim => Err(ProgramError::Custom(u32::MAX)),
    }
}
