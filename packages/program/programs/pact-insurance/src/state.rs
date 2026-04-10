use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,

    pub protocol_fee_bps: u16,
    pub min_pool_deposit: u64,
    pub default_insurance_rate_bps: u16,
    pub default_max_coverage_per_call: u64,
    pub min_premium_bps: u16,

    pub withdrawal_cooldown_seconds: i64,
    pub aggregate_cap_bps: u16,
    pub aggregate_cap_window_seconds: i64,

    pub claim_window_seconds: i64,
    pub max_claims_per_batch: u8,

    pub paused: bool,

    pub bump: u8,
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol";
}
