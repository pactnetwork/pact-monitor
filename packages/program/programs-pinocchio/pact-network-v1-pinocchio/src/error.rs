use pinocchio::error::ProgramError;

/// Pact Network V1 error codes.
///
/// Numbering policy (Step C refactor):
/// - Codes that survived the agent-custody removal keep their original
///   numbers — clients keyed off them shouldn't have to remap.
/// - Codes that only triggered from the now-deleted instructions
///   (initialize_agent_wallet, deposit_usdc, request_withdrawal,
///   execute_withdrawal, claim_refund) are removed: 6003
///   (WithdrawalCooldownActive), 6004 (NoPendingWithdrawal), 6009
///   (DepositCapExceeded). Their slots are intentionally left as gaps
///   rather than reused — this keeps the surviving numbers stable for
///   off-chain log scrapers.
/// - New errors introduced for the fee-recipient layer start at 6016
///   (next free slot after 6015 ArithmeticOverflow) and grow contiguously.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PactError {
    InsufficientBalance = 6000,
    EndpointPaused = 6001,
    ExposureCapExceeded = 6002,
    // 6003 — reserved (was WithdrawalCooldownActive)
    // 6004 — reserved (was NoPendingWithdrawal)
    UnauthorizedSettler = 6005,
    UnauthorizedAuthority = 6006,
    DuplicateCallId = 6007,
    EndpointNotFound = 6008,
    // 6009 — reserved (was DepositCapExceeded)
    PoolDepleted = 6010,
    InvalidTimestamp = 6011,
    BatchTooLarge = 6012,
    PremiumTooSmall = 6013,
    InvalidSlug = 6014,
    ArithmeticOverflow = 6015,
    // Fee-recipient and protocol-config errors (Step C/C):
    FeeRecipientArrayTooLong = 6016,
    FeeBpsExceedsCap = 6017,
    FeeBpsSumOver10k = 6018,
    FeeRecipientDuplicateDestination = 6019,
    FeeRecipientInvalidUsdcMint = 6020,
    MultipleTreasuryRecipients = 6021,
    RecipientCoverageMismatch = 6022,
    ProtocolConfigNotInitialized = 6023,
    TreasuryNotInitialized = 6024,
    EndpointAlreadyRegistered = 6025,
    InvalidFeeRecipientKind = 6026,
}

impl From<PactError> for ProgramError {
    fn from(e: PactError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
