#![allow(unexpected_cfgs)]

pub mod constants;
pub mod discriminator;
pub mod error;
pub mod fee;
pub mod instructions;
pub mod pda;
pub mod state;
pub mod system;
pub mod token;

use pinocchio::{account::AccountView, error::ProgramError, ProgramResult};
use solana_address::Address;

use discriminator::Discriminator;

#[cfg(feature = "bpf-entrypoint")]
pinocchio::entrypoint!(process_instruction);

solana_address::declare_id!("DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc");

/// Discriminator allocation policy: see `discriminator.rs`. Slots 0, 5, 6, 7,
/// 8, 11 are intentionally left as gaps (deleted instructions reserve their
/// numbers; new instructions append at 12+). This keeps `match` errors
/// loud rather than re-routing legacy traffic to unrelated handlers.
pub fn process_instruction(
    _program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let (disc_byte, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match Discriminator::try_from(*disc_byte)? {
        Discriminator::InitializeSettlementAuthority => {
            instructions::initialize_settlement_authority::process(accounts, rest)
        }
        Discriminator::RegisterEndpoint => {
            instructions::register_endpoint::process(accounts, rest)
        }
        Discriminator::UpdateEndpointConfig => {
            instructions::update_endpoint_config::process(accounts, rest)
        }
        Discriminator::PauseEndpoint => {
            instructions::pause_endpoint::process(accounts, rest)
        }
        Discriminator::TopUpCoveragePool => {
            instructions::top_up_coverage_pool::process(accounts, rest)
        }
        Discriminator::SettleBatch => {
            instructions::settle_batch::process(accounts, rest)
        }
        Discriminator::InitializeProtocolConfig => {
            instructions::initialize_protocol_config::process(accounts, rest)
        }
        Discriminator::InitializeTreasury => {
            instructions::initialize_treasury::process(accounts, rest)
        }
        Discriminator::UpdateFeeRecipients => {
            instructions::update_fee_recipients::process(accounts, rest)
        }
    }
}
