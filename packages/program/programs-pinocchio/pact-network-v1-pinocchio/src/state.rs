use bytemuck::{Pod, Zeroable};
use solana_address::Address;

// ---------------------------------------------------------------------------
// CoveragePool — singleton PDA [b"coverage_pool"]
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CoveragePool {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub authority: Address,
    pub usdc_mint: Address,
    pub usdc_vault: Address,
    pub total_deposits: u64,
    pub total_premiums: u64,
    pub total_refunds: u64,
    pub current_balance: u64,
    pub created_at: i64,
}

unsafe impl Zeroable for CoveragePool {}
unsafe impl Pod for CoveragePool {}

impl CoveragePool {
    // 1+7+32+32+32+8+8+8+8+8 = 144
    pub const LEN: usize = 1 + 7 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8;
}

// ---------------------------------------------------------------------------
// EndpointConfig — PDA [b"endpoint", slug[16]]
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct EndpointConfig {
    pub bump: u8,
    pub paused: u8,
    pub _padding0: [u8; 6],
    pub slug: [u8; 16],
    pub flat_premium_lamports: u64,
    pub percent_bps: u16,
    pub _padding1: [u8; 6],
    pub sla_latency_ms: u32,
    pub _padding2: [u8; 4],
    pub imputed_cost_lamports: u64,
    pub exposure_cap_per_hour_lamports: u64,
    pub current_period_start: i64,
    pub current_period_refunds: u64,
    pub total_calls: u64,
    pub total_breaches: u64,
    pub total_premiums: u64,
    pub total_refunds: u64,
    pub last_updated: i64,
}

unsafe impl Zeroable for EndpointConfig {}
unsafe impl Pod for EndpointConfig {}

impl EndpointConfig {
    // 1+1+6+16+8+2+6+4+4+8+8+8+8+8+8+8+8+8 = 120
    pub const LEN: usize = 1 + 1 + 6 + 16 + 8 + 2 + 6 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8;
}

// ---------------------------------------------------------------------------
// AgentWallet — PDA [b"agent_wallet", owner.key()]
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AgentWallet {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub owner: Address,
    pub usdc_vault: Address,
    pub balance: u64,
    pub total_deposits: u64,
    pub total_premiums_paid: u64,
    pub total_refunds_received: u64,
    pub total_refunds_claimed: u64,
    pub call_count: u64,
    pub pending_withdrawal: u64,
    pub withdrawal_unlock_at: i64,
    pub created_at: i64,
}

unsafe impl Zeroable for AgentWallet {}
unsafe impl Pod for AgentWallet {}

impl AgentWallet {
    // 1+7+32+32+8+8+8+8+8+8+8+8+8 = 144
    pub const LEN: usize = 1 + 7 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8;
}

// ---------------------------------------------------------------------------
// CallRecord — PDA [b"call", call_id[16]] — dedup sentinel
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CallRecord {
    pub bump: u8,
    pub breach: u8,
    pub _padding0: [u8; 6],
    pub call_id: [u8; 16],
    pub agent_wallet: Address,
    pub endpoint_slug: [u8; 16],
    pub premium_lamports: u64,
    pub refund_lamports: u64,
    pub latency_ms: u32,
    pub _padding1: [u8; 4],
    pub timestamp: i64,
}

unsafe impl Zeroable for CallRecord {}
unsafe impl Pod for CallRecord {}

impl CallRecord {
    // 1+1+6+16+32+16+8+8+4+4+8 = 104
    pub const LEN: usize = 1 + 1 + 6 + 16 + 32 + 16 + 8 + 8 + 4 + 4 + 8;
}

// ---------------------------------------------------------------------------
// SettlementAuthority — singleton PDA [b"settlement_authority"]
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SettlementAuthority {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub signer: Address,
    pub set_at: i64,
}

unsafe impl Zeroable for SettlementAuthority {}
unsafe impl Pod for SettlementAuthority {}

impl SettlementAuthority {
    // 1+7+32+8 = 48
    pub const LEN: usize = 1 + 7 + 32 + 8;
}
