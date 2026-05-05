use pinocchio::error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PactError {
    InsufficientBalance = 6000,
    EndpointPaused = 6001,
    ExposureCapExceeded = 6002,
    WithdrawalCooldownActive = 6003,
    NoPendingWithdrawal = 6004,
    UnauthorizedSettler = 6005,
    UnauthorizedAuthority = 6006,
    DuplicateCallId = 6007,
    EndpointNotFound = 6008,
    DepositCapExceeded = 6009,
    PoolDepleted = 6010,
    InvalidTimestamp = 6011,
    BatchTooLarge = 6012,
    PremiumTooSmall = 6013,
    InvalidSlug = 6014,
    ArithmeticOverflow = 6015,
}

impl From<PactError> for ProgramError {
    fn from(e: PactError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
