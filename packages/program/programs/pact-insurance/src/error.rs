use anchor_lang::prelude::*;

#[error_code]
pub enum PactError {
    #[msg("Protocol is paused")]
    ProtocolPaused,

    #[msg("Pool already exists for this provider")]
    PoolAlreadyExists,

    #[msg("Policy already exists for this agent and pool")]
    PolicyAlreadyExists,

    #[msg("Policy is not active")]
    PolicyInactive,

    #[msg("Pool does not have sufficient available balance")]
    InsufficientPoolBalance,

    #[msg("Policy prepaid balance is insufficient")]
    InsufficientPrepaidBalance,

    #[msg("Withdrawal cooldown has not elapsed")]
    WithdrawalUnderCooldown,

    #[msg("Withdrawal would underfund active policy obligations")]
    WithdrawalWouldUnderfund,

    #[msg("Aggregate payout cap exceeded for current window")]
    AggregateCapExceeded,

    #[msg("Claim submission window has expired")]
    ClaimWindowExpired,

    #[msg("Duplicate claim for this call_id")]
    DuplicateClaim,

    #[msg("Invalid rate")]
    InvalidRate,

    #[msg("Hostname exceeds maximum length")]
    HostnameTooLong,

    #[msg("Agent ID exceeds maximum length")]
    AgentIdTooLong,

    #[msg("Call ID exceeds maximum length")]
    CallIdTooLong,

    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Invalid trigger type")]
    InvalidTriggerType,

    #[msg("Amount must be non-zero")]
    ZeroAmount,

    #[msg("Amount is below minimum pool deposit")]
    BelowMinimumDeposit,

    #[msg("Config value violates hardcoded safety floor")]
    ConfigSafetyFloorViolation,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}
