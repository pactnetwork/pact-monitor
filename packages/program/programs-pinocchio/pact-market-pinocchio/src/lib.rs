#![allow(unexpected_cfgs)]

pub mod constants;
pub mod discriminator;
pub mod error;
pub mod instructions;
pub mod pda;
pub mod state;
pub mod system;
pub mod token;

use pinocchio::{account::AccountView, error::ProgramError, ProgramResult};
use solana_address::Address;

use discriminator::Discriminator;

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::nostd_panic_handler!();

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::entrypoint!(process_instruction);

solana_address::declare_id!("11111111111111111111111111111111");

pub fn process_instruction(
    _program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let (disc_byte, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match Discriminator::try_from(*disc_byte)? {
        Discriminator::InitializeCoveragePool => {
            instructions::initialize_coverage_pool::process(accounts, rest)
        }
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
        Discriminator::InitializeAgentWallet => {
            instructions::initialize_agent_wallet::process(accounts, rest)
        }
        Discriminator::DepositUsdc => {
            instructions::deposit_usdc::process(accounts, rest)
        }
        Discriminator::RequestWithdrawal => {
            instructions::request_withdrawal::process(accounts, rest)
        }
        Discriminator::ExecuteWithdrawal => {
            instructions::execute_withdrawal::process(accounts, rest)
        }
        Discriminator::TopUpCoveragePool => {
            instructions::top_up_coverage_pool::process(accounts, rest)
        }
        Discriminator::SettleBatch => {
            instructions::settle_batch::process(accounts, rest)
        }
        Discriminator::ClaimRefund => {
            instructions::claim_refund::process(accounts, rest)
        }
    }
}
