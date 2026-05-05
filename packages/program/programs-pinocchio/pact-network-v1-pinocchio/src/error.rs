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
    // Codex 2026-05-05 review fixes (mainnet blocker class):
    /// 6027 — supplied ProtocolConfig is not the canonical [b"protocol_config"]
    /// PDA, or is not owned by this program.
    InvalidProtocolConfig = 6027,
    /// 6028 — supplied Treasury is not the canonical [b"treasury"] PDA, or is
    /// not owned by this program.
    InvalidTreasury = 6028,
    /// 6029 — fee_recipients does not contain exactly one Treasury entry.
    /// Treasury must always be present so the protocol fee path is funded.
    MissingTreasuryEntry = 6029,
    /// 6030 — Treasury entry's bps is zero. Treasury must take a non-zero cut
    /// when present in the array; if you really want zero treasury take, omit
    /// the Treasury entry entirely (which is itself rejected by 6029).
    TreasuryBpsZero = 6030,
    /// 6031 — an AffiliateAta destination is not a valid initialized SPL
    /// Token account, mint != ProtocolConfig.usdc_mint, or otherwise fails
    /// the strict ATA invariants. Returned by register_endpoint and
    /// update_fee_recipients.
    InvalidAffiliateAta = 6031,
}

impl From<PactError> for ProgramError {
    fn from(e: PactError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
