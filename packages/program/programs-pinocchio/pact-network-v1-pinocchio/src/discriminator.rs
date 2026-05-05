use pinocchio::error::ProgramError;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Discriminator {
    InitializeCoveragePool = 0,
    InitializeSettlementAuthority = 1,
    RegisterEndpoint = 2,
    UpdateEndpointConfig = 3,
    PauseEndpoint = 4,
    InitializeAgentWallet = 5,
    DepositUsdc = 6,
    RequestWithdrawal = 7,
    ExecuteWithdrawal = 8,
    TopUpCoveragePool = 9,
    SettleBatch = 10,
    ClaimRefund = 11,
}

impl TryFrom<u8> for Discriminator {
    type Error = ProgramError;

    fn try_from(v: u8) -> Result<Self, Self::Error> {
        match v {
            0 => Ok(Discriminator::InitializeCoveragePool),
            1 => Ok(Discriminator::InitializeSettlementAuthority),
            2 => Ok(Discriminator::RegisterEndpoint),
            3 => Ok(Discriminator::UpdateEndpointConfig),
            4 => Ok(Discriminator::PauseEndpoint),
            5 => Ok(Discriminator::InitializeAgentWallet),
            6 => Ok(Discriminator::DepositUsdc),
            7 => Ok(Discriminator::RequestWithdrawal),
            8 => Ok(Discriminator::ExecuteWithdrawal),
            9 => Ok(Discriminator::TopUpCoveragePool),
            10 => Ok(Discriminator::SettleBatch),
            11 => Ok(Discriminator::ClaimRefund),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
