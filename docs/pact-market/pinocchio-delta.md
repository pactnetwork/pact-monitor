# Pinocchio Delta: Pact Market V1 vs Existing pact-insurance-pinocchio

**Branch:** `analysis/pact-market-pinocchio-delta`
**Date:** 2026-05-04
**Analyst:** pinocchio-delta-analyst (crew agent)

---

## 1. Summary

**Recommendation: Option C — a separate Pinocchio crate.**

The existing `pact-insurance-pinocchio` crate models a multi-underwriter insurance program with pools, policies, claims, and a crank-driven premium settlement flow. Pact Market's on-chain program (PRD §11) is a structurally different product: an agent pre-funded wallet drained per call, endpoint registry, and a single trusted settler that batches micro-settlements per block. The two programs share almost no account structure, no instruction semantics, and no PDA seed schemes. Shoehorning them into one crate (Option A) would mix two unrelated product domains inside a single binary with no correctness benefit. Generalizing existing accounts (Option B) would require migrating live devnet state and would likely break the referrer/policy/claim flow that the insurance team is still evolving. A second Pinocchio crate (Option C) is the same 82% cheaper than Anchor in deploy cost, carries zero risk to the existing `7i9zJ…` devnet deployment, and produces a clean separation that will matter when the programs eventually diverge on mainnet. The two crates can share Rust utility modules (token CPI helpers, PDA derivation patterns) via workspace cargo features without coupling their discriminator spaces or account layouts.

---

## 2. PRD §11 Specification (verbatim)

### State accounts

**CoveragePool** (one global pool; no underwriters in V1)
PDA seeds: `[b"coverage_pool"]`
```
pub struct CoveragePool {
    pub bump: u8,
    pub authority: Pubkey,
    pub usdc_vault: Pubkey,         // ATA owned by this PDA
    pub balance: u64,
    pub total_deposits: u64,
    pub total_premiums_earned: u64,
    pub total_refunds_paid: u64,
}
impl CoveragePool {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 8 + 8 + 8 + 8;
}
```

**EndpointConfig** (one per registered endpoint slug)
PDA seeds: `[b"endpoint", slug.as_bytes()]` (slug max 16 bytes)
```
pub struct EndpointConfig {
    pub bump: u8,
    pub slug: [u8; 16],             // null-padded ASCII
    pub flat_premium_lamports: u64,
    pub percent_bps: u16,
    pub sla_latency_ms: u32,
    pub imputed_cost_lamports: u64,
    pub exposure_cap_per_hour_lamports: u64,
    pub paused: bool,
    pub total_calls: u64,
    pub total_breaches: u64,
    pub total_premiums: u64,
    pub total_refunds: u64,
    pub last_updated: i64,
}
impl EndpointConfig {
    pub const LEN: usize = 8 + 1 + 16 + 8 + 2 + 4 + 8 + 8 + 1 + 8 + 8 + 8 + 8 + 8;
}
```

**AgentWallet** (one per agent)
PDA seeds: `[b"agent_wallet", owner.key().as_ref()]`
```
pub struct AgentWallet {
    pub bump: u8,
    pub owner: Pubkey,
    pub usdc_vault: Pubkey,         // ATA owned by this PDA
    pub balance: u64,               // mirrored
    pub total_deposits: u64,
    pub total_premiums_paid: u64,
    pub total_refunds_received: u64,
    pub call_count: u64,
    pub pending_withdrawal: u64,
    pub withdrawal_unlock_at: i64,  // 0 if no pending
    pub created_at: i64,
}
impl AgentWallet {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8;
}
```

**CallRecord** (one per call settlement, deduplication record)
PDA seeds: `[b"call", call_id.as_ref()]` (call_id is 16 bytes UUID)
```
pub struct CallRecord {
    pub bump: u8,
    pub call_id: [u8; 16],
    pub agent_wallet: Pubkey,
    pub endpoint_slug: [u8; 16],
    pub premium_lamports: u64,
    pub refund_lamports: u64,
    pub latency_ms: u32,
    pub breach: bool,
    pub timestamp: i64,
}
impl CallRecord {
    pub const LEN: usize = 8 + 1 + 16 + 32 + 16 + 8 + 8 + 4 + 1 + 8;
}
```

**SettlementAuthority** (singleton)
PDA seeds: `[b"settlement_authority"]`
```
pub struct SettlementAuthority {
    pub bump: u8,
    pub signer: Pubkey,             // hot key in V1, multisig in V2
    pub set_at: i64,
}
impl SettlementAuthority {
    pub const LEN: usize = 8 + 1 + 32 + 8;
}
```

### Instructions

```rust
// initialize_coverage_pool
pub fn initialize_coverage_pool(
    ctx: Context<InitializeCoveragePool>,
) -> Result<()>

// initialize_settlement_authority
pub fn initialize_settlement_authority(
    ctx: Context<InitializeSettlementAuthority>,
    signer: Pubkey,
) -> Result<()>

// register_endpoint
pub fn register_endpoint(
    ctx: Context<RegisterEndpoint>,
    slug: [u8; 16],
    flat_premium_lamports: u64,
    percent_bps: u16,
    sla_latency_ms: u32,
    imputed_cost_lamports: u64,
    exposure_cap_per_hour_lamports: u64,
) -> Result<()>

// update_endpoint_config (any subset of fields)
pub fn update_endpoint_config(
    ctx: Context<UpdateEndpointConfig>,
    flat_premium: Option<u64>,
    percent_bps: Option<u16>,
    sla_latency_ms: Option<u32>,
    imputed_cost: Option<u64>,
    exposure_cap: Option<u64>,
) -> Result<()>

// pause_endpoint
pub fn pause_endpoint(
    ctx: Context<PauseEndpoint>,
    paused: bool,
) -> Result<()>

// initialize_agent_wallet
pub fn initialize_agent_wallet(
    ctx: Context<InitializeAgentWallet>,
) -> Result<()>

// deposit_usdc
pub fn deposit_usdc(
    ctx: Context<DepositUsdc>,
    amount: u64,
) -> Result<()>

// request_withdrawal (starts cooldown)
pub fn request_withdrawal(
    ctx: Context<RequestWithdrawal>,
    amount: u64,
) -> Result<()>

// execute_withdrawal (after cooldown)
pub fn execute_withdrawal(
    ctx: Context<ExecuteWithdrawal>,
) -> Result<()>

// top_up_coverage_pool
pub fn top_up_coverage_pool(
    ctx: Context<TopUpCoveragePool>,
    amount: u64,
) -> Result<()>

// settle_batch — gated to settlement_authority
pub fn settle_batch(
    ctx: Context<SettleBatch>,
    events: Vec<SettlementEvent>,
) -> Result<()>
```

`SettlementEvent` struct (passed inline in `settle_batch`):
```rust
pub struct SettlementEvent {
    pub call_id: [u8; 16],
    pub agent_wallet: Pubkey,
    pub endpoint_slug: [u8; 16],
    pub premium_lamports: u64,
    pub refund_lamports: u64,
    pub latency_ms: u32,
    pub breach: bool,
    pub timestamp: i64,
}
```

### Errors enum

```rust
// packages/program/programs/pact_market/src/errors.rs
#[error_code]
pub enum PactError {
    #[msg("Insufficient agent wallet balance")]
    InsufficientBalance = 6000,
    #[msg("Endpoint is paused")]
    EndpointPaused = 6001,
    #[msg("Hourly exposure cap exceeded for this endpoint")]
    ExposureCapExceeded = 6002,
    #[msg("Withdrawal cooldown still active")]
    WithdrawalCooldownActive = 6003,
    #[msg("No pending withdrawal to execute")]
    NoPendingWithdrawal = 6004,
    #[msg("Caller is not the settlement authority")]
    UnauthorizedSettler = 6005,
    #[msg("Caller is not the pool authority")]
    UnauthorizedAuthority = 6006,
    #[msg("Duplicate call ID in this batch")]
    DuplicateCallId = 6007,
    #[msg("Endpoint not found")]
    EndpointNotFound = 6008,
    #[msg("Deposit amount exceeds per-wallet cap")]
    DepositCapExceeded = 6009,
    #[msg("Pool balance insufficient for refund")]
    PoolDepleted = 6010,
    #[msg("Settlement event timestamp is in the future")]
    InvalidTimestamp = 6011,
    #[msg("Batch size exceeds maximum")]
    BatchTooLarge = 6012,
    #[msg("Premium below minimum")]
    PremiumTooSmall = 6013,
    #[msg("Slug must be ASCII bytes, null-padded to 16")]
    InvalidSlug = 6014,
}
```

### Events

```rust
// packages/program/programs/pact_market/src/events.rs

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct EndpointRegistered {
    pub slug: [u8; 16],
    pub sla_latency_ms: u32,
    pub flat_premium_lamports: u64,
}

#[event]
pub struct EndpointPaused {
    pub slug: [u8; 16],
    pub paused: bool,
}

#[event]
pub struct AgentWalletInitialized {
    pub owner: Pubkey,
    pub wallet: Pubkey,
}

#[event]
pub struct DepositMade {
    pub wallet: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct WithdrawalRequested {
    pub wallet: Pubkey,
    pub amount: u64,
    pub unlock_at: i64,
}

#[event]
pub struct WithdrawalExecuted {
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PremiumDebited {
    pub call_id: [u8; 16],
    pub wallet: Pubkey,
    pub slug: [u8; 16],
    pub amount: u64,
}

#[event]
pub struct RefundCredited {
    pub call_id: [u8; 16],
    pub wallet: Pubkey,
    pub slug: [u8; 16],
    pub amount: u64,
    pub reason: u8,             // 0=latency, 1=upstream_failure
}

#[event]
pub struct ExposureCapHit {
    pub slug: [u8; 16],
    pub period_start: i64,
}

#[event]
pub struct PoolToppedUp {
    pub amount: u64,
    pub new_balance: u64,
}
```

### Security invariants (verbatim from PRD §11)

1. Agent USDC tokens are held in the AgentWallet PDA's vault. Withdrawals require the wallet owner to sign AND the cooldown to elapse.
2. Coverage pool USDC is held in the CoveragePool PDA's vault. Outflows happen only via `settle_batch` (refunds) and `withdraw_pool` (V2; not in V1).
3. `settle_batch` is gated to the `settlement_authority.signer` keypair. No other caller can credit refunds or debit premiums.
4. Per-endpoint hourly exposure cap is enforced in-program: each batch checks current period's refund total against cap; rejects events that would exceed.
5. Each `call_id` can be settled at most once. The CallRecord PDA serves as the deduplication mechanism (init-if-needed pattern; second settlement with same call_id fails because account already exists).
6. All u64 arithmetic uses checked operations (`checked_add`, `checked_sub`). Any overflow returns `ArithmeticOverflow (6015, new variant)`.

> **PRD inconsistency note:** PRD §11 security invariants point 6 says checked arithmetic returns `MathOverflow`, but the PRD's error enum (codes 6000-6014, §11) has no such variant. The existing pact-insurance crate uses `ArithmeticOverflow = 6023`. Recommend the new pact-market-pinocchio crate add `ArithmeticOverflow = 6015` to its error enum and amend the PRD accordingly.
7. Authority over endpoint config is the pool's authority pubkey. In V2 this becomes a multisig.

---

## 3. Existing Pinocchio Crate Inventory

**Program ID:** `7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU` (devnet)

### State structs (`src/state.rs` — 834 LOC)

| Struct | Discriminator | LEN | Key fields |
|---|---|---|---|
| `ProtocolConfig` | 0 | 256 | authority, oracle, treasury, usdc_mint; protocol_fee_bps, default_insurance_rate_bps, withdrawal_cooldown_seconds, aggregate_cap_bps, claim_window_seconds, paused, bump |
| `CoveragePool` | 1 | 320 | authority, usdc_mint, vault; provider_hostname [u8;64], total_deposited, total_available, total_premiums_earned, total_claims_paid, max_coverage_per_call, payouts_this_window, insurance_rate_bps, active_policies, bump, _pad_tail[0]=vault_bump |
| `UnderwriterPosition` | 2 | 184 | pool, underwriter; deposited, earned_premiums, losses_absorbed, deposit_timestamp, last_claim_timestamp, bump |
| `Policy` | 3 | 320 | agent, pool, agent_token_account; agent_id [u8;64], total_premiums_paid, total_claims_received, calls_covered, created_at, expires_at, active, referrer [u8;32], referrer_share_bps, referrer_present |
| `Claim` | 4 | 288 | policy, pool, agent; call_id [u8;32] (SHA-256 digest), evidence_hash [u8;32], payment_amount, refund_amount, latency_ms, status_code, trigger_type, status, bump |

All structs: `#[repr(C)]`, `bytemuck::Pod`, first domain field at byte offset 8, trailing `reserved: [u8;64]`.

### Instructions (`src/instructions/` — 11 handlers)

| Discriminator | Handler | Signer | Key behavior |
|---|---|---|---|
| 0 | `initialize_protocol` | deployer (hardcoded pubkey) | Creates ProtocolConfig PDA, deployer-locked |
| 1 | `update_config` | authority | Mutates 13 ProtocolConfig fields individually via Option args; frozen fields (treasury, usdc_mint) always rejected |
| 2 | `update_oracle` | authority | Rotates config.oracle; rejects zero address and self-referential oracle |
| 3 | `create_pool` | authority | Creates CoveragePool + SPL vault PDA; mints must match config.usdc_mint (bug fix) |
| 4 | `deposit` | underwriter | Transfer from underwriter ATA to vault; init-or-reopen UnderwriterPosition; resets cooldown on every deposit |
| 5 | `enable_insurance` | agent | Creates Policy PDA linking agent to pool; snapshots referrer if provided |
| 6 | `disable_policy` | agent | Sets policy.active=0; decrements pool.active_policies with saturating_sub |
| 7 | `settle_premium` | oracle | Crank-driven 3-way split: pool_cut + treasury_cut + referrer_cut from agent delegated ATA; H-05 no active gate |
| 8 | `withdraw` | underwriter | Pool-PDA-signed Transfer vault→underwriter ATA; enforces cooldown (floor 3600s) |
| 9 | `update_rates` | oracle | Updates pool.insurance_rate_bps; bounded by [min_premium_bps, 10000] |
| 10 | `submit_claim` | oracle | Creates Claim PDA (dedup by sha256(call_id)); pool-PDA-signed Transfer vault→agent ATA; aggregate cap enforced per window |

### Errors (`src/error.rs` — 31 variants, 6000–6030)

`ProtocolPaused(6000)`, `PoolAlreadyExists(6001)`, `PolicyAlreadyExists(6002)`, `DelegationMissing(6003)`, `DelegationInsufficient(6004)`, `TokenAccountMismatch(6005)`, `PolicyInactive(6006)`, `InsufficientPoolBalance(6007)`, `InsufficientPrepaidBalance(6008)`, `WithdrawalUnderCooldown(6009)`, `WithdrawalWouldUnderfund(6010)`, `AggregateCapExceeded(6011)`, `ClaimWindowExpired(6012)`, `DuplicateClaim(6013)`, `InvalidRate(6014)`, `HostnameTooLong(6015)`, `AgentIdTooLong(6016)`, `CallIdTooLong(6017)`, `Unauthorized(6018)`, `InvalidTriggerType(6019)`, `ZeroAmount(6020)`, `BelowMinimumDeposit(6021)`, `ConfigSafetyFloorViolation(6022)`, `ArithmeticOverflow(6023)`, `UnauthorizedDeployer(6024)`, `UnauthorizedOracle(6025)`, `FrozenConfigField(6026)`, `RateOutOfBounds(6027)`, `RateBelowFloor(6028)`, `PolicyExpired(6029)`, `InvalidOracleKey(6030)`

### PDA seeds (`src/pda.rs`)

| Seed | Usage |
|---|---|
| `b"protocol"` | Singleton ProtocolConfig |
| `[b"pool", hostname_bytes]` | Per-provider CoveragePool; variable-length hostname |
| `[b"vault", pool_pda]` | SPL vault for each pool |
| `[b"position", pool, underwriter]` | Per-underwriter deposit position |
| `[b"policy", pool, agent]` | Per-agent insurance policy |
| `[b"claim", policy, sha256(call_id)]` | Per-call dedup record |

### Infrastructure modules

- `src/token.rs` — SPL Transfer (user-signed + pool-PDA-signed), InitializeAccount3 (153 LOC)
- `src/token_account.rs` — raw byte readers for mint, owner, delegate, amount, delegated_amount (217 LOC)
- `src/system.rs` — CreateAccount CPI wrapper (60 LOC)
- `src/discriminator.rs` — 11-variant enum dispatched by entrypoint (38 LOC)
- `src/constants.rs` — safety floors, defaults, string length caps (41 LOC)

**Existing crate total: ~5,716 LOC**

---

## 4. Overlap Matrix

| PRD §11 item | Existing equivalent | Verdict | Notes |
|---|---|---|---|
| **CoveragePool** account | `CoveragePool` (discriminator 1, 320 bytes) | NEW | Pact Market's pool has no underwriters, no per-provider hostname, no insurance_rate_bps, no active_policies counter. Field set is ~30% overlapping by name but semantically different (balance vs total_deposited/available split, no vault_bump trick). Same name is a coincidence; they are different entities. |
| **EndpointConfig** account | Nothing equivalent | NEW | Concept does not exist in pact-insurance. Closest: provider_hostname inside CoveragePool, but that is a pool key, not a per-endpoint config record. |
| **AgentWallet** account | `Policy` (discriminator 3, 320 bytes) | NEW | Policy tracks coverage relationships between agent+pool; AgentWallet tracks prepaid USDC balance with a withdrawal state machine. Completely different semantics despite both referencing an agent pubkey. |
| **CallRecord** account | `Claim` (discriminator 4, 288 bytes) | NEW | Claim stores evidence hashes, trigger types, refund resolution, and status transitions. CallRecord is a thin dedup receipt written atomically in settle_batch. Different shape, different lifecycle. |
| **SettlementAuthority** account | Partial: `ProtocolConfig.oracle` | NEW | config.oracle is the pact-insurance oracle key embedded in a multi-field singleton config. SettlementAuthority is its own PDA with its own seed and a dedicated signer field. Not shareable without a migration. |
| **initialize_coverage_pool** ix | `create_pool` (discriminator 3) | NEW | create_pool creates a per-provider pool with SPL vault, hostname seeds, and Underwriter model. PM's initialize_coverage_pool creates a single global pool with no hostname, different seed. |
| **initialize_settlement_authority** ix | Nothing equivalent | NEW | No counterpart in pact-insurance. |
| **register_endpoint** ix | Nothing equivalent | NEW | No counterpart. EndpointConfig as a concept is fully absent from pact-insurance. |
| **update_endpoint_config** ix | `update_rates` (discriminator 9) + `update_config` (discriminator 1) | NEW | update_rates only touches insurance_rate_bps on a CoveragePool; update_config only touches the ProtocolConfig singleton. Neither maps to per-endpoint slug-keyed config mutation. |
| **pause_endpoint** ix | Partial: `update_config` paused field | NEW | update_config pauses the entire protocol. pause_endpoint pauses a single endpoint. Different scope. |
| **initialize_agent_wallet** ix | `enable_insurance` (discriminator 5) | NEW | enable_insurance creates a Policy linking agent to a pool with delegation/referrer. initialize_agent_wallet creates a USDC-holding PDA with a balance. Different type, different lifetime, different CPI pattern. |
| **deposit_usdc** ix | `deposit` (discriminator 4) | ADAPT (50%) | Both: user signs, Transfer from user ATA to a vault PDA, init-or-reopen a PDA, update balance counters. Key differences: deposit targets UnderwriterPosition+CoveragePool (two accounts updated); deposit_usdc targets AgentWallet only. No cooldown reset on agent deposit. vault_bump pattern differs. Token helper modules can be shared. |
| **request_withdrawal** ix | `withdraw` (discriminator 8) | NEW | withdraw is immediate (after cooldown elapses from deposit_timestamp). request_withdrawal sets a pending state; a separate execute_withdrawal fires after cooldown. Two-step vs one-step. |
| **execute_withdrawal** ix | Nothing equivalent | NEW | Two-step withdrawal pattern does not exist in pact-insurance. |
| **top_up_coverage_pool** ix | `deposit` (discriminator 4) | ADAPT (30%) | Both Transfer USDC into a vault. Different target accounts, different signer constraints (pool authority vs agent). Borrows the Transfer helper but logic differs substantially. |
| **settle_batch** ix | `settle_premium` (7) + `submit_claim` (10) | NEW | settle_batch is a single oracle-gated instruction that atomically writes CallRecord PDAs, debits agent wallets, and credits pool refunds for a Vec of events. pact-insurance uses two separate cranks (settle_premium for premiums, submit_claim for refunds) with very different account structures (Policy PDA required, delegation model, sha256 call_id, aggregate cap window). The batch-settlement-event vector pattern has no analog. |
| **Errors 6000–6014** | Overlapping codes 6000–6030 | NEW | PM's 15 error variants start at 6000 and have different meanings at each code point. pact-insurance uses 6000–6030 with different semantics (e.g., 6000 = ProtocolPaused vs InsufficientBalance; 6005 = TokenAccountMismatch vs UnauthorizedSettler). Both programs cannot live in the same error namespace without aliasing. This alone is a strong argument against Option A or B. |
| **Events** (10 events) | None | NEW | pact-insurance emits no events (Pinocchio port does not include an event system). |
| **Security invariants 1–7** | Partially analogous | NEW | Invariants 1–3 (vault custody, settle_batch gating) parallel pact-insurance's vault + oracle model at a conceptual level, but the account structures that enforce them are entirely different. Cannot share implementation. |

**Summary: 0 REUSE, 2 ADAPT (30–50%, token Transfer helpers only), 9 NEW state accounts/instructions (counting groups).**

---

## 5. Three Options

### Option A — Side-by-side modules in same crate

Add a `pact_market` module inside `pact-insurance-pinocchio`. New Pact Market state accounts use PDA seed prefixes `b"pm_pool"`, `b"pm_endpoint"`, `b"pm_wallet"`, `b"pm_call"`, `b"pm_settler"`. Extend the `Discriminator` enum beyond variant 10.

**Analysis:**

The overlap matrix shows essentially zero shared state logic. The crate would grow from 5,716 LOC to approximately 9,500 LOC (~3,800 new) while hosting two products that share only token Transfer helpers. The discriminator enum would jump from 11 to 22 variants. More critically, error codes 6000–6030 are already assigned in pact-insurance with different semantics. PRD §11 defines PM errors also starting at 6000. Inside a shared crate these would collide at the ProgramError::Custom level unless PM uses a different base offset (e.g., 7000), which diverges from the PRD spec and makes SDK clients write branching error handling. The conceptual coupling is the real cost: reviewers, future developers, and auditors reading the binary cannot reason about the two products independently. Any change to shared infrastructure (token.rs, system.rs) would require re-testing both products. There is no deploy-cost saving — a single larger binary is marginally more expensive than one of the two separate smaller ones.

- **Pro:** Single program ID to manage; existing devnet stays untouched if PM module uses distinct seeds.
- **Con:** Error code collision with PRD §11; discriminator namespace crowded; two unrelated products in one audit surface; combined binary is larger; any shared module edit requires full regression test of both products.
- **Risk:** HIGH. Error code base conflict requires either violating PRD §11 spec or creating a permanent quirk that will trip SDK clients. If the wrong accounts are passed to the wrong module's handler, the program must distinguish product context from account discriminators alone.
- **Hours:** 30–40h (handlers + tests + error remapping) with medium implementation confidence and high ongoing maintenance cost.
- **Confidence:** Low that this is the right call.

### Option B — Generalize existing accounts

Reshape `CoveragePool`, `Policy`, and `Claim` to accommodate both products by adding a `product_kind: u8` field. `CoveragePool` becomes the Pact Market pool with `product_kind=1`; the existing insurance `CoveragePool` becomes `product_kind=0`. Migrate devnet state or redeploy.

**Analysis:**

The account shapes are incompatible at a deep level. pact-insurance's `CoveragePool` has a `provider_hostname [u8;64]` field that seeds its PDA; PM's coverage pool has no hostname. Their PDAs would derive differently. Policy vs AgentWallet have no meaningful field overlap — Policy is a coverage relationship; AgentWallet is a payment instrument with balance state. Adding `product_kind` would not resolve the structural differences; handlers would need large `if product_kind == 0 { ... } else { ... }` branches that bypass the type system entirely. The `reserved: [u8;64]` pad in each struct is insufficient to absorb the new fields without a schema migration on the five live devnet accounts. Codama-TS bindings would need to be regenerated and versioned for both product shapes simultaneously, which is a higher maintenance burden than two separate IDLs.

- **Pro:** Single program; single set of Codama-generated TS bindings.
- **Con:** Requires devnet state migration (5 accounts); breaks Codama-TS SDK (currently used in production-intent integration tests); structural incompatibility forces branching handler logic that defeats the purpose of typed state; two unrelated product models in one layout spec.
- **Risk:** CRITICAL. Migrating live devnet state mid-development breaks the existing pact-insurance test suite (tests-pinocchio/*.ts, ~5,213 LOC). The insurance team is still actively iterating (PR #47 open). Any regression here directly delays Colosseum submission.
- **Hours:** 50–70h (migration instruction, layout changes, Codama regen, full regression).
- **Confidence:** Very low. This option is not recommended under any scenario.

### Option C — Separate Pinocchio crate

Add a new crate at `packages/program/programs-pinocchio/pact-market-pinocchio/` with its own `Cargo.toml`, `src/lib.rs`, program ID (generated at `cargo build-sbf` time), and independent discriminator space. Token Transfer helpers and the raw account-borrow patterns from pact-insurance can be copied or factored into a shared workspace lib (e.g., `packages/program/programs-pinocchio/pinocchio-common/`) if Alan decides that is worth the overhead.

**Analysis:**

This is structurally the same cost as pact-insurance-pinocchio was when it was written: a fresh Pinocchio crate of ~3,800 implementation LOC plus ~1,200 test LOC. Deploy cost on devnet is ~0.15–0.20 SOL (vs 5.55 SOL for Anchor), consistent with the 82% savings documented in the existing deploy. Two program IDs to manage is the real operational cost, but both will be constants in the settler worker and SDK — not a runtime burden. The existing `7i9zJ…` devnet deployment is completely unaffected. The Codama-TS SDK for pact-insurance (already live) does not need to change. The new crate gets its own Codama IDL, its own types, and its own error namespace that exactly matches PRD §11. When either product evolves on mainnet, changes are isolated to one binary.

- **Pro:** Clean separation; exact PRD §11 compliance (error codes, account shapes, PDAs as spec'd); zero risk to existing devnet; Codama-TS for pact-insurance unchanged; two smaller binaries are collectively cheaper to deploy than one large binary.
- **Con:** Two program IDs; two `cargo build-sbf` invocations in CI; settler worker must be initialized with two program IDs (trivial config).
- **Risk:** LOW. Only new files. No existing tests affected. The primary risk is time (below).
- **Hours:** 28–38h for full implementation:
  - Crate scaffold + Cargo.toml: 2h
  - State accounts (5 structs + bytemuck layout): 6h
  - PDA module: 2h
  - Error enum (15 variants): 1h
  - 11 instruction handlers: 18–22h (settle_batch is the complex one at ~6h alone)
  - Codama IDL generation: 2h
  - Integration tests (TypeScript, ~1,200 LOC): 4–6h
- **Confidence:** High.

---

## 6. Recommendation

**Option C — Separate Pinocchio crate.**

The overlap matrix is decisive: 0 items can be directly reused from pact-insurance, and the PRD §11 error code namespace starts at 6000 with different semantics than the existing crate's 6000–6030 range. This alone makes Option A untenable without spec deviation. Option B requires migrating live devnet state during active development, creating critical-path risk for the May 11 deadline. Option C adds ~35 hours of work but carries no regression risk, produces a clean Codama IDL that matches the PRD exactly, and keeps the two products independently auditable. The operational cost of two program IDs is real but trivial — a two-line config change in the settler worker.

The PRD's original Anchor 0.31.1 choice was also coherent, but given the existing team commitment to Pinocchio (demonstrated by the full 11-instruction port already completed), using Anchor for the second program would split the codebase across two frameworks, two IDL formats, and two dependency trees. A second Pinocchio crate is the consistent choice.

---

## 7. Concrete File Plan (Option C)

### New crate root

| Path | Contents |
|---|---|
| `packages/program/programs-pinocchio/pact-market-pinocchio/Cargo.toml` | Package metadata; deps: pinocchio 0.10 + cpi, bytemuck 1.14, solana-address 2 (same as pact-insurance); no sha2 needed (call_id is 16-byte UUID, no hashing required since UUID fits within the 32-byte seed limit) |
| `packages/program/programs-pinocchio/pact-market-pinocchio/src/lib.rs` | `declare_id!`, module declarations, DEPLOYER_PUBKEY constant |

### New source files

| Path | Description | Est. LOC |
|---|---|---|
| `src/state.rs` | 5 structs: CoveragePool, EndpointConfig, AgentWallet, CallRecord, SettlementAuthority; `#[repr(C)]`, `bytemuck::Pod`, offset asserts, round-trip tests | 400 |
| `src/error.rs` | PactMarketError enum, 15 variants 6000–6014 | 60 |
| `src/pda.rs` | 5 seed sets + derive_* helpers + pinned fixture tests | 200 |
| `src/constants.rs` | MAX_SLUG_LEN=16, MAX_BATCH_SIZE, WITHDRAWAL_COOLDOWN_SECONDS, EXPOSURE_CAP_WINDOW_SECONDS | 30 |
| `src/discriminator.rs` | 11-variant Discriminator enum (0=InitializeCoveragePool … 10=SettleBatch) | 40 |
| `src/entrypoint.rs` | `process_instruction` dispatcher | 30 |
| `src/token.rs` | Copy from pact-insurance (or import shared lib): user-signed Transfer, pool-PDA-signed Transfer, InitializeAccount3 | 153 |
| `src/token_account.rs` | Copy from pact-insurance: raw byte readers | 217 |
| `src/system.rs` | Copy from pact-insurance: CreateAccount CPI | 60 |
| `src/instructions/mod.rs` | Module declarations | 15 |
| `src/instructions/initialize_coverage_pool.rs` | Creates CoveragePool PDA + SPL vault; authority-signed | 120 |
| `src/instructions/initialize_settlement_authority.rs` | Creates SettlementAuthority PDA; authority-signed; signer arg | 80 |
| `src/instructions/register_endpoint.rs` | Creates EndpointConfig PDA; authority-signed; slug + pricing args | 150 |
| `src/instructions/update_endpoint_config.rs` | Mutates EndpointConfig; authority-signed; Option<T> args per field | 180 |
| `src/instructions/pause_endpoint.rs` | Sets EndpointConfig.paused; authority-signed | 80 |
| `src/instructions/initialize_agent_wallet.rs` | Creates AgentWallet PDA + SPL vault; agent-signed | 120 |
| `src/instructions/deposit_usdc.rs` | User-signed Transfer ATA→agent vault; updates balance; init-if-needed omitted (wallet already exists) | 150 |
| `src/instructions/request_withdrawal.rs` | Sets pending_withdrawal + withdrawal_unlock_at; agent-signed; no CPI | 100 |
| `src/instructions/execute_withdrawal.rs` | After cooldown: wallet-PDA-signed Transfer vault→agent ATA; clears pending state | 150 |
| `src/instructions/top_up_coverage_pool.rs` | authority-signed Transfer from authority ATA to pool vault | 100 |
| `src/instructions/settle_batch.rs` | Core instruction: oracle-signed; iterates Vec<SettlementEvent>; init-or-no-op CallRecord PDA per call_id; debits AgentWallet; credits pool on breach; enforces exposure cap per endpoint per window; checked arithmetic throughout | 500 |

**New implementation subtotal: ~2,935 LOC**

### Existing files to leave alone

Everything under `packages/program/programs-pinocchio/pact-insurance-pinocchio/`. Zero modifications.

### Test files to add

| Path | Description | Est. LOC |
|---|---|---|
| `packages/program/tests-pinocchio/pact-market/pool.ts` | initialize_coverage_pool, top_up_coverage_pool, authority guards | 200 |
| `packages/program/tests-pinocchio/pact-market/endpoints.ts` | register_endpoint, update_endpoint_config, pause_endpoint | 250 |
| `packages/program/tests-pinocchio/pact-market/wallet.ts` | initialize_agent_wallet, deposit, request/execute withdrawal, cooldown enforcement | 300 |
| `packages/program/tests-pinocchio/pact-market/settle.ts` | settle_batch: happy path, SLA breach + refund, dedup (duplicate call_id), exposure cap exceeded, unauthorized settler | 400 |

**Test subtotal: ~1,150 LOC**

**Grand total new code: ~4,085 LOC**

---

## 8. Risk Register

| Risk | Severity | Notes |
|---|---|---|
| **`settle_batch` compute budget** | HIGH | A batch of N events writes N CallRecord PDAs (each a CreateAccount CPI) plus 1–2 Transfer CPIs per breach. At N=20 events with 5 breaches, that is 25 CPIs. Default compute limit is 200,000 CU. Each CreateAccount + Token Transfer chain costs ~15,000–20,000 CU. N=10 is likely safe; N=20 may require `set_compute_unit_limit`. PRD §11 sets a `BatchTooLarge` error but does not specify the max. Alan needs to pick a concrete limit before implementation begins. |
| **AgentWallet vault authority pattern** | MEDIUM | Pact Market's AgentWallet vault is owned by the AgentWallet PDA, not by the pool. The Transfer CPI on `execute_withdrawal` must be wallet-PDA-signed (seeds: `[b"agent_wallet", owner]`). The pattern is identical to pact-insurance's pool-PDA-signed Transfer — well-understood — but the seed must be constructed carefully since the agent's pubkey is in the seed (not a hostname byte slice). |
| **Exposure cap per endpoint per hour** | MEDIUM | EndpointConfig has a single `exposure_cap_per_hour_lamports` field but no rolling window counters in the PRD §11 spec. `settle_batch` must track `(current_period_start, current_period_refunds)` somewhere. The CallRecord approach (count from chain state) is too expensive per-call. Either the EndpointConfig needs two additional fields (period_start: i64, period_refunds: u64) not in the PRD §11 layout, or the settler worker pre-validates. This is an open question the PRD does not fully answer — see ASK-ALAN below. |
| **Devnet USDC mint** | LOW | Both programs must use the same USDC mint address on devnet (likely the Circle devnet USDC or a local test mint). The pact-insurance ProtocolConfig.usdc_mint is set at initialize_protocol. Pact Market's CoveragePool.usdc_vault must use the same mint. No conflict, but whoever initializes the PM pool must use the same USDC mint that the existing devnet infrastructure already minted test tokens for. |
| **Two program IDs in settler worker** | LOW | The Fly.io settler worker currently submits transactions to one program. It needs a second program ID constant and a Codama-generated TS SDK for pact-market. This is a TypeScript config change, not an on-chain risk. |
| **No state migration needed** | NONE | This is a new crate. No existing accounts are touched. |

---

## 9. Open Questions

**[ASK-ALAN-1]** `settle_batch` compute budget: what is the maximum batch size? PRD §11 defines `BatchTooLarge = 6012` but does not give a number. The settler worker (Fly.io, Node.js) can split into multiple transactions at any size, so the on-chain limit just needs to be a safe ceiling. Suggested: 10 events per batch (5 CreateAccount + 5 Transfer CPIs worst-case = ~100k CU comfortably under 200k). Confirm or set a different number.

**[ASK-ALAN-2]** Exposure cap enforcement: EndpointConfig has `exposure_cap_per_hour_lamports` and `total_refunds` but the PRD §11 struct has no rolling-window state (no `period_start` or `period_refunds` fields). The program needs somewhere to store the current window's refund accumulator to enforce security invariant #4. Options: (a) add two fields to EndpointConfig not in the PRD layout (period_start: i64, period_refunds: u64, +16 bytes), (b) enforce only in the settler worker (off-chain, weaker security), (c) derive it from scanning CallRecord accounts (too expensive). Recommended: option (a). Confirm.

**[ASK-ALAN-3]** Where does the Codama IDL generation live for the new crate? The existing pact-insurance IDL is in `packages/program/idl/`. Does the new crate get its own IDL file there, or should there be a `packages/insurance-market/` package for the TS SDK analogous to `packages/insurance/`?

**[ASK-ALAN-4]** Should `token.rs` and `token_account.rs` be copied into the new crate (fast, independent) or factored into a shared workspace crate (e.g., `pinocchio-common`)? Given the May 11 deadline, copy-paste is faster and safe. Sharing them costs an extra Cargo workspace member and dependency graph change but reduces future drift. What is your preference?

**[ASK-ALAN-5]** The PRD §11 spec says `settle_batch` deduplicates via the CallRecord PDA (init-if-needed: second settlement fails because account already exists). The `call_id` is a 16-byte UUID used directly as a PDA seed. Confirm: no SHA-256 hashing is needed here (unlike pact-insurance's 64-byte call_id that required hashing to fit in 32 bytes), since 16 bytes fits within Solana's 32-byte seed limit natively.
