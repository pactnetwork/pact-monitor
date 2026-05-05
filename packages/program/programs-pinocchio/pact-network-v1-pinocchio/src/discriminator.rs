use pinocchio::error::ProgramError;

/// Instruction discriminators (Step C refactor).
///
/// Numbering policy: deleted instructions (the agent-custody family +
/// initialize_coverage_pool, which is now folded into register_endpoint)
/// keep their numeric slots reserved rather than being reused. New
/// instructions are appended to the tail. This keeps any off-chain log
/// scrapers that switch on the leading byte stable across the rename.
///
/// Reserved (do not reuse):
///   0  — was InitializeCoveragePool (folded into RegisterEndpoint)
///   5  — was InitializeAgentWallet (custody removed)
///   6  — was DepositUsdc            (custody removed)
///   7  — was RequestWithdrawal      (custody removed)
///   8  — was ExecuteWithdrawal      (custody removed)
///   11 — was ClaimRefund            (refund now goes direct in settle_batch)
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Discriminator {
    InitializeSettlementAuthority = 1,
    RegisterEndpoint = 2,
    UpdateEndpointConfig = 3,
    PauseEndpoint = 4,
    TopUpCoveragePool = 9,
    SettleBatch = 10,
    InitializeProtocolConfig = 12,
    InitializeTreasury = 13,
    UpdateFeeRecipients = 14,
}

impl TryFrom<u8> for Discriminator {
    type Error = ProgramError;

    fn try_from(v: u8) -> Result<Self, Self::Error> {
        match v {
            1 => Ok(Discriminator::InitializeSettlementAuthority),
            2 => Ok(Discriminator::RegisterEndpoint),
            3 => Ok(Discriminator::UpdateEndpointConfig),
            4 => Ok(Discriminator::PauseEndpoint),
            9 => Ok(Discriminator::TopUpCoveragePool),
            10 => Ok(Discriminator::SettleBatch),
            12 => Ok(Discriminator::InitializeProtocolConfig),
            13 => Ok(Discriminator::InitializeTreasury),
            14 => Ok(Discriminator::UpdateFeeRecipients),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
