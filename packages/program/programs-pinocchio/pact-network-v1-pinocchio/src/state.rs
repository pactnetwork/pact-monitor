use bytemuck::{Pod, Zeroable};
use solana_address::Address;

// ---------------------------------------------------------------------------
// FeeRecipient — 48-byte fixed entry. Embedded inline in EndpointConfig and
// ProtocolConfig as a static array of length 8.
// ---------------------------------------------------------------------------

/// Discriminant for the recipient destination shape.
///
/// V1 supports three flavours; only one Treasury entry is allowed per
/// endpoint. AffiliateAta is a USDC ATA; AffiliatePda is reserved for future
/// program-derived recipients (the program does not enforce any ATA-specific
/// invariants on it in V1).
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FeeRecipientKind {
    Treasury = 0,
    AffiliateAta = 1,
    AffiliatePda = 2,
}

impl FeeRecipientKind {
    #[inline]
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(FeeRecipientKind::Treasury),
            1 => Some(FeeRecipientKind::AffiliateAta),
            2 => Some(FeeRecipientKind::AffiliatePda),
            _ => None,
        }
    }
}

/// 48-byte fee recipient entry. Layout-stable, no per-entry padding bytes
/// other than the explicit `_pad0` / `_pad1`.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct FeeRecipient {
    pub kind: u8,
    pub _pad0: [u8; 7],      // align destination to 8
    pub destination: Address, // 32 bytes
    pub bps: u16,
    pub _pad1: [u8; 6], // align next entry to 8 — total 48 bytes
}

unsafe impl Zeroable for FeeRecipient {}
unsafe impl Pod for FeeRecipient {}

impl FeeRecipient {
    pub const LEN: usize = 1 + 7 + 32 + 2 + 6;
    pub const ZERO: Self = Self {
        kind: 0,
        _pad0: [0; 7],
        destination: Address::new_from_array([0u8; 32]),
        bps: 0,
        _pad1: [0; 6],
    };
}

const _: () = assert!(FeeRecipient::LEN == 48);
const _: () = assert!(core::mem::size_of::<FeeRecipient>() == 48);

// ---------------------------------------------------------------------------
// CoveragePool — per-endpoint PDA [b"coverage_pool", endpoint_slug[16]]
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CoveragePool {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub authority: Address,
    pub usdc_mint: Address,
    pub usdc_vault: Address,
    pub endpoint_slug: [u8; 16],
    pub total_deposits: u64,
    pub total_premiums: u64,
    pub total_refunds: u64,
    pub current_balance: u64,
    pub created_at: i64,
}

unsafe impl Zeroable for CoveragePool {}
unsafe impl Pod for CoveragePool {}

impl CoveragePool {
    // 1+7+32+32+32+16+8+8+8+8+8 = 160
    pub const LEN: usize = 1 + 7 + 32 + 32 + 32 + 16 + 8 + 8 + 8 + 8 + 8;
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
    // Per-endpoint coverage pool (informational/cached — settler reads it to
    // skip re-deriving). Set at register_endpoint time and never mutated.
    pub coverage_pool: Address,
    pub fee_recipient_count: u8,
    pub _padding3: [u8; 7],
    pub fee_recipients: [FeeRecipient; 8],
}

unsafe impl Zeroable for EndpointConfig {}
unsafe impl Pod for EndpointConfig {}

impl EndpointConfig {
    // 120 (legacy fields) + 32 (coverage_pool) + 1 + 7 (count + pad) + 8*48 = 544
    pub const LEN: usize = 1 + 1 + 6 + 16 + 8 + 2 + 6 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8
        + 32 + 1 + 7 + 8 * FeeRecipient::LEN;
}

const _: () = assert!(EndpointConfig::LEN == 544);
const _: () = assert!(core::mem::size_of::<EndpointConfig>() == 544);

// ---------------------------------------------------------------------------
// CallRecord — PDA [b"call", call_id[16]] — dedup sentinel
// ---------------------------------------------------------------------------

/// Settlement outcome flag stamped on every CallRecord during settle_batch.
///
/// Added 2026-05-05 in response to codex review feedback (per-event status +
/// explicit pool-depleted / cap-clamped accounting). Off-chain indexers read
/// this byte to surface settlement failures instead of inferring them from
/// `actual_refund_lamports == 0` — premium can be charged with no refund for
/// reasons other than a non-breach call.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SettlementStatus {
    /// Happy path — premium charged + refund (if any) paid in full.
    Settled = 0,
    /// SPL Token Transfer with delegate authority failed. Premium was NOT
    /// charged for this event; the rest of the batch continues.
    DelegateFailed = 1,
    /// Premium charged + fees fanned out, but pool USDC vault did not have
    /// enough liquidity to pay the requested refund. `actual_refund_lamports`
    /// is 0 in this case; intended refund is still in `refund_lamports`.
    PoolDepleted = 2,
    /// Premium charged + fees fanned out, but the hourly per-endpoint exposure
    /// cap clamped the refund. `actual_refund_lamports` is the partial amount
    /// actually transferred (may be 0).
    ExposureCapClamped = 3,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CallRecord {
    pub bump: u8,
    pub breach: u8,
    /// SettlementStatus discriminant. See `SettlementStatus`.
    pub settlement_status: u8,
    pub _padding0: [u8; 5],
    pub call_id: [u8; 16],
    pub agent: Address, // agent owner pubkey (was agent_wallet PDA before)
    pub endpoint_slug: [u8; 16],
    pub premium_lamports: u64,
    /// Intended/requested refund (= breach amount the settler computed).
    pub refund_lamports: u64,
    /// Refund actually paid out of the pool to the agent ATA. Equal to
    /// `refund_lamports` on the happy path; smaller (incl. 0) when the pool
    /// was depleted or the hourly exposure cap clamped the payout. Indexer
    /// should display both so ops can see the gap.
    pub actual_refund_lamports: u64,
    pub latency_ms: u32,
    pub _padding1: [u8; 4],
    pub timestamp: i64,
}

unsafe impl Zeroable for CallRecord {}
unsafe impl Pod for CallRecord {}

impl CallRecord {
    // 1+1+1+5+16+32+16+8+8+8+4+4+8 = 112
    pub const LEN: usize = 1 + 1 + 1 + 5 + 16 + 32 + 16 + 8 + 8 + 8 + 4 + 4 + 8;
}

const _: () = assert!(CallRecord::LEN == 112);
const _: () = assert!(core::mem::size_of::<CallRecord>() == 112);

// ---------------------------------------------------------------------------
// SettlementAuthority — singleton PDA [b"settlement_authority"]
//
// The PDA itself is the SPL Token delegate every agent pre-approves
// off-chain via SPL `Approve`; the program signs as this PDA via
// `invoke_signed` to pull premiums from agent ATAs during settle_batch.
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

// ---------------------------------------------------------------------------
// Treasury — singleton PDA [b"treasury"]
//
// Receives the protocol-side share of premium fan-out. V1 sets the authority
// equal to the pool authority for simplicity; the USDC vault is an ATA owned
// by the Treasury PDA.
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Treasury {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub authority: Address,
    pub usdc_vault: Address,
    pub set_at: i64,
}

unsafe impl Zeroable for Treasury {}
unsafe impl Pod for Treasury {}

impl Treasury {
    // 1+7+32+32+8 = 80
    pub const LEN: usize = 1 + 7 + 32 + 32 + 8;
}

// ---------------------------------------------------------------------------
// ProtocolConfig — singleton PDA [b"protocol_config"]
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ProtocolConfig {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub authority: Address,
    pub usdc_mint: Address,
    pub max_total_fee_bps: u16,
    pub default_fee_recipient_count: u8,
    pub _padding1: [u8; 5],
    pub default_fee_recipients: [FeeRecipient; 8],
}

unsafe impl Zeroable for ProtocolConfig {}
unsafe impl Pod for ProtocolConfig {}

impl ProtocolConfig {
    // 1+7+32+32+2+1+5+8*48 = 464
    pub const LEN: usize = 1 + 7 + 32 + 32 + 2 + 1 + 5 + 8 * FeeRecipient::LEN;
}

const _: () = assert!(ProtocolConfig::LEN == 464);
const _: () = assert!(core::mem::size_of::<ProtocolConfig>() == 464);
