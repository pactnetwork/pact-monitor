# Phase 4: WP-EVM-04 PactSettler Happy Path — Research

**Researched:** 2026-05-18
**Domain:** Solana-to-EVM behavioral parity port — `settle_batch.rs` happy-path
per-event loop → `PactSettler.settleBatch` in Solidity
**Confidence:** HIGH (all claims derived directly from the Solana source files
and the existing EVM codebase; no external web research required)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- D-LOCK-1: `settle_batch.rs` is the sole parity authority. Plan/spec code
  blocks and scaffold `TODO` comments are NON-authoritative sketches.
- D-LOCK-2: Strict TDD — write failing test, confirm RED, implement, confirm
  GREEN. Never skip the red step.
- D-LOCK-3: Divergence ledger (design-spec §4) is closed. §4#1 ERC-20
  `transferFrom` + try/catch == `DelegateFailed`; §4#2 single contract +
  `mapping(bytes16 slug => …)`; §4#3 first-class `event` per state transition
  is the indexer truth source (EVM has NO `CallRecord`); §4#4 `uint64` value
  widths; §4#5 OZ `AccessControl` `SETTLER_ROLE`; §4#8 USDC 6-dec ERC-20.
- D-LOCK-4: Pool decisions D1-D6 stand. Pool hooks are `onlyRole(SETTLER_ROLE)`
  and `registry.isRegistered(slug)`-gated. WP-04 COMPOSES them; does NOT
  reopen D1-D6.
- D-LOCK-5: PORT vs N-A rule — PORT every scenario whose behavior survives the
  §4 ledger. Mark N-A-ON-EVM only for genuine Solana-platform mechanics.
- D-LOCK-6: No emojis; conventional commits; `pnpm`+`forge`; file-scoped
  commits; NO `git add -A`/`-a`; NO push/PR comment until captain approves
  final gate.

### WP-04 vs WP-05 Scope Split (D-SPLIT)

WP-04 ports 9 happy-path tests from `05-settle-batch.test.ts`:
1. "single event with default 10% Treasury fan-out"
2. "single event with explicit Treasury 10% + Affiliate 5% (85/10/5)"
3. "breach event refunds agent ATA directly from pool vault"
4. "mixed batch across 3 endpoints with different fee templates"
5. "revoke between events: subsequent settle marks DelegateFailed and continues"
6. "min-premium edge: premium < MIN_PREMIUM_LAMPORTS rejected"
7. "duplicate call_id rejected"
8. "unauthorized settler rejected"
9. "happy path: CallRecord settlement_status = Settled (0)"

WP-05 defers 4 tests:
- "pool depleted: refund skipped, CallRecord marked PoolDepleted"
- "exposure cap clamps refund: CallRecord marked ExposureCapClamped"
- "settle_batch rejects with ProtocolPaused when paused = 1"
- "settle_batch resumes after pause -> unpause"

### OPEN — GATE A Design Decisions (captain rules; planner records, not resolves)

E1, E2, E3, E4 — see §OPEN items below.

### Claude's Discretion (within parity)

- Internal helper structure of `settleBatch` (loop layout, local caching)
- Foundry test util layout
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SET-01 | `settleBatch` gated by settler role; unauthorized caller reverts | E2 resolution + OZ AccessControl pattern from PactPool.t.sol |
| SET-02 | Premium-in via `transferFrom(agent, pool, premium)` in try/catch; DelegateFailed on failure, batch continues | §Q3 (premium-in mechanics) + §Q4 (dedup-on-failure) |
| SET-03 | Per-event guards: PremiumTooSmall, InvalidTimestamp, RecipientCoverageMismatch | §Q1 (per-event order, lines 158-166, 213-215) |
| SET-04 | Repeated callId → DuplicateCallId via mapping(bytes16 => bool) | §Q1 (dedup, line 194-196) |
| SET-05 | Pool credited gross premium; fee fan-out floor-div; pool retains residual | §Q2 (fee math, lines 426-453) |
| SET-06 | On breach with sufficient liquidity and within cap: full refund, status Settled | §Q1 (refund block, lines 455-502); WP-04 happy path = no clamp triggers |
| SET-07 | Stats accounting identical arithmetic/ordering to settle_batch.rs | §Q5 (stats, lines 385-395, 496-498) + E1 characterization |
| SET-08 | Exactly one CallSettled event per call with all required fields | §Q6 (E4 resolution mapping) |
</phase_requirements>

---

## Summary

WP-EVM-04 is a behavioral parity port — the entire implementation surface is
already determined by `settle_batch.rs`. The research task is to re-derive the
exact per-event loop in full, map every mutation and computation to its EVM
equivalent, characterize the four GATE A decisions (E1-E4), and ensure the
planner can write a TDD task breakdown with bit-identical numeric targets.

All happy-path logic flows through a well-defined 10-step per-event sequence
(§Q1 below). The key economic computation (fee fan-out) uses a u128
intermediate floor-div on Solana that maps directly to uint256 intermediate
floor-div in Solidity (§Q2). The premium-in failure path is the most
structurally interesting: on Solana a pre-flight byte read replaces a
try/catch; on EVM a raw `IERC20.transferFrom` wrapped in a Solidity try/catch
is the parity-faithful equivalent (§Q3). The CallRecord PDA (Solana's per-call
persisted state) is entirely replaced by a `mapping(bytes16 => bool)` dedup
sentinel plus a `CallSettled` event (§Q6).

**Primary recommendation:** Implement `settleBatch` as a single external
function on `PactSettler` (upgraded to inherit `AccessControl`), iterating the
`SettlementEvent[]` calldata array with explicit per-step composure of the
four WP-03 pool hooks. All 9 happy-path Foundry tests must mirror the exact
numeric assertions from `05-settle-batch.test.ts`.

---

## Research Question Answers

### Q1 — Exact per-event order of operations (happy path)

Source: `settle_batch.rs`, verified line by line.

**Pre-loop (WP-05 territory — NOT in WP-04 loop body):**
- Lines 105-115: protocol-paused check → `ProtocolPaused` (WP-05).
- Lines 117-130: settler-signer vs `SettlementAuthority.signer` match → `UnauthorizedSettler`.
  On EVM this becomes `onlyRole(SETTLER_ROLE)` on the function entry (SET-01).
- Lines 132-135: `event_count > MAX_BATCH_SIZE` → `BatchTooLarge` (WP-05).

**Per-event loop body — step order (each iteration `i` over `events[]`):**

**Step 1 — Decode event fields** (lines 148-156)
```
call_id [u8;16], agent_owner [u8;32], endpoint_slug [u8;16],
premium_lamports u64, refund_lamports u64, latency_ms u32,
breach u8, fee_count_hint u8, timestamp i64
```
EVM: already in calldata as `SettlementEvent` struct fields; no decode needed.

**Step 2 — Per-event guards** (lines 158-166)
- `timestamp > now` → `InvalidTimestamp`
- `premium_lamports < MIN_PREMIUM_LAMPORTS` → `PremiumTooSmall`
- `fee_count_hint > MAX_FEE_RECIPIENTS` → `FeeRecipientArrayTooLong`

These are hard reverts on the whole transaction (not per-event continues).
[VERIFIED: settle_batch.rs:158-166]

**Step 3 — Endpoint snapshot + endpoint-paused check** (lines 200-221)
- Read `EndpointConfig` (on Solana: borrow `endpoint_acct`).
- Lines 209-211: `ep.paused != 0` → `EndpointPaused` (WP-05).
- Lines 212-215: `ep_count != fee_count_hint` → `RecipientCoverageMismatch` (hard revert).
- Capture `fee_recipients[]` + bps snapshot.
EVM: `IPactRegistry.getEndpoint(slug)` returns `EndpointConfig memory`; check
`ep.feeRecipientCount != ev.feeRecipientCountHint` → `RecipientCoverageMismatch`.
The endpoint-paused branch (WP-05) is NOT implemented in WP-04 but the
snapshot call itself is needed for the fee-recipients array.

**Step 4 — Dedup** (lines 194-196, executed before the endpoint borrow in source)
IMPORTANT: In `settle_batch.rs` the dedup check (`!call_record_acct.is_data_empty()`)
occurs at line 194, BEFORE the endpoint snapshot borrow at line 200. The
CallRecord PDA is ALLOCATED (line 255-262) before the premium-in attempt.
This means the dedup sentinel is written to the account BEFORE the delegate
check, so a DelegateFailed event ALSO marks the call_id as seen.

EVM mapping: `mapping(bytes16 => bool) private _settledCallIds`.
- Check: `if (_settledCallIds[ev.callId]) revert DuplicateCallId()` — hard revert.
- Set: `_settledCallIds[ev.callId] = true` immediately after the dedup check
  passes (before the premium-in attempt), so DelegateFailed events also
  deduplicate on retry. [VERIFIED: settle_batch.rs:194-196, 248-262]

**Step 5 — Premium-in** (lines 295-330)
Solana: pre-flight reads SPL Token ATA buffer (offset 72-129) to check
delegate discriminant == 1, delegate pubkey == settlement_authority, and
`delegated_amount >= premium_lamports`. If not OK, sets
`status = DelegateFailed`, writes CallRecord, `continue`s. No CPI is
attempted.

EVM: try/catch around `IERC20(usdc).transferFrom(ev.agent, address(pool), ev.premium)`.
- On catch: `status = DelegateFailed`, emit `CallSettled`, `continue`.
- NO funds move for that event; pool state unchanged for that event.
- The dedup mapping IS already set (Step 4 above), so a retry of the same
  callId is rejected with `DuplicateCallId`.

[VERIFIED: settle_batch.rs:295-355]

**Critical note on `transferFrom` mechanism (§4#1):**
`PactPool` uses `SafeERC20` for its own calls, but the settler's premium-in
`transferFrom` is an EXTERNAL call FROM `PactSettler` on `IERC20`. To make
the try/catch work, the call must NOT use `SafeERC20` (which would itself
revert on failure, propagating up and defeating the catch). The correct
pattern is a raw `IERC20.transferFrom` inside a try/catch:
```solidity
try IERC20(usdc).transferFrom(ev.agent, address(pool), ev.premium) {
    // success path
} catch {
    // DelegateFailed path
}
```
This is the parity-faithful mechanism. `SafeERC20.safeTransferFrom` MUST NOT
be used for this specific call. [VERIFIED against settle_batch.rs:280-330 commentary]

**Step 6 — Pool gross credit** (lines 357-369, on premium-in success)
```rust
cp.current_balance = cp.current_balance.checked_add(premium_lamports)?;
cp.total_premiums   = cp.total_premiums.checked_add(premium_lamports)?;
```
EVM: `pool.creditPremium(ev.endpointSlug, ev.premium)` — already ships in
WP-03 and mirrors both mutations exactly. [VERIFIED: settle_batch.rs:360-368,
PactPool.creditPremium]

**Step 7 — Endpoint stats** (lines 380-416)

This block is split across WP-04 and WP-05. The boundary analysis follows
directly from the source (see §Q5 for the full E1 characterization):

Lines 385-395 (WP-04 territory — pure additive stats, no clamp decision):
```rust
ep.total_calls    = ep.total_calls.checked_add(1)?;
ep.total_premiums = ep.total_premiums.checked_add(premium_lamports)?;
if breach != 0 {
    ep.total_breaches = ep.total_breaches.checked_add(1)?;
}
```

Lines 396-415 (WP-04/05 boundary — the exposure window block):
```rust
if now > ep.current_period_start + 3600 {         // line 396 — period RESET
    ep.current_period_start = now;
    ep.current_period_refunds = 0;
}
if intended_refund_after_cap > 0 {
    let cap_remaining = ep.exposure_cap_per_hour_lamports
        .saturating_sub(ep.current_period_refunds);
    if intended_refund_after_cap > cap_remaining { // line 404 — CLAMP DECISION
        intended_refund_after_cap = cap_remaining;
        status = SettlementStatus::ExposureCapClamped as u8; // WP-05
    }
    if intended_refund_after_cap > 0 {
        ep.current_period_refunds = ep.current_period_refunds // line 410-414
            .checked_add(intended_refund_after_cap)?;         // ADDITIVE accounting
    }
}
```

**Boundary ruling derivation from source:**
- The period RESET (lines 397-399) and the cap-clamp DECISION
  (lines 404-408, `status = ExposureCapClamped`) are WP-05 behaviors because
  they only matter when the clamp fires.
- The `current_period_refunds += actual_refund` ACCOUNTING at lines 410-414
  is WP-04 territory on the happy path: when no clamp fires
  (`intended_refund_after_cap <= cap_remaining`), the += still executes and
  is part of faithful refund bookkeeping.
- However: on the happy path in WP-04 tests, the default exposure cap is
  `5_000_000` (from `registerSimpleEndpoint` default), refund amounts are
  small (50_000 in the breach test, 0 in the non-breach tests), and
  `current_period_refunds` starts at 0 — so the clamp branch never fires and
  `current_period_refunds += refund` executes unconditionally.

**Conclusion:** The `current_period_refunds += actual_refund` line IS
WP-04 work (it executes on the happy path), but it is contingent on the full
exposure-window block being present. The planner MUST implement the additive
`current_period_refunds` accounting as part of endpoint stats (E1), since it
executes in all 9 happy-path tests where `refund > 0`. The period RESET and
the clamp-decision branch guard (`status = ExposureCapClamped`) are WP-05.
This is NOT ambiguous — the source is unambiguous on which lines execute on
the happy path.

The `ep.total_refunds` mutation is at lines 496-499 (inside the refund block,
Step 9 below). [VERIFIED: settle_batch.rs:380-416]

**Step 8 — Fee fan-out** (lines 418-453)

```rust
let mut total_fee_paid: u64 = 0;
for j in 0..ep_count {
    let bps = fee_recipients_snapshot[j].bps as u128;
    let fee_amount = (premium_lamports as u128 * bps / 10_000u128) as u64;
    if fee_amount == 0 { continue; }
    // transfer pool_vault → fee_recipient_ata[j]
    total_fee_paid = total_fee_paid.checked_add(fee_amount)?;
}
if total_fee_paid > 0 {
    cp.current_balance -= total_fee_paid;  // checked_sub
}
```

EVM mapping:
```solidity
uint64 totalFeePaid = 0;
for (uint8 j = 0; j < ep.feeRecipientCount; j++) {
    uint64 feeAmount = uint64(
        uint256(ev.premium) * ep.feeRecipients[j].bps / 10_000
    );
    if (feeAmount == 0) continue;
    pool.payout(ep.feeRecipients[j].destination, feeAmount);
    totalFeePaid = _ckAdd(totalFeePaid, feeAmount);
}
if (totalFeePaid > 0) {
    pool.debitForFees(ev.endpointSlug, totalFeePaid);
}
```

Key details:
- Solana casts `premium_lamports as u128`, multiplies by `bps as u128`,
  divides by `10_000u128`, then casts back to `u64`. This is integer floor
  division (truncation toward zero — identical to Solidity's `/`).
- EVM: `uint256(ev.premium) * ep.feeRecipients[j].bps / 10_000` gives
  identical truncation. Downcast to `uint64` is safe because
  `premium * bps / 10_000 <= premium <= type(uint64).max`.
- Zero-fee skip: `if fee_amount == 0 { continue }` — reproduced exactly.
- `total_fee_paid` accumulation uses `checked_add` → `ArithmeticOverflow`.
- `pool.payout(dest, feeAmount)` is the egress call (WP-03 settler hook).
- `pool.debitForFees(slug, totalFeePaid)` debits `current_balance` only
  (mirrors the single `cp.current_balance -= total_fee_paid` write).
- The pool RESIDUAL (premium minus all fees) stays implicitly — no explicit
  "residual" write; `current_balance` already reflects it after the debit.

[VERIFIED: settle_batch.rs:418-453]

**Step 9 — Refund on breach** (lines 455-502, WP-04 happy path: pool has
liquidity AND within cap, so no clamp fires)

```rust
if intended_refund_after_cap > 0 {
    let pool_balance = cp.current_balance;
    if pool_balance < intended_refund_after_cap {
        status = PoolDepleted;           // WP-05
        actual_refund_lamports = 0;
    } else {
        // transfer pool_vault → agent_ata
        actual_refund_lamports = intended_refund_after_cap;
        cp.current_balance -= actual_refund_lamports;   // checked_sub
        cp.total_refunds   += actual_refund_lamports;   // checked_add
        ep.total_refunds   += actual_refund_lamports;   // checked_add
    }
}
```

WP-04 only executes the `else` branch (sufficient pool balance, within cap).
EVM mapping:
```solidity
uint64 actualRefund = 0;
if (ev.refund > 0) {   // ev.refund == intended_refund_after_cap on happy path
    IPactPool.PoolState memory ps = pool.balanceOf(ev.endpointSlug);
    if (ps.currentBalance < ev.refund) {
        status = SettlementStatus.PoolDepleted;  // WP-05 — not executed in WP-04
    } else {
        pool.payout(ev.agent, ev.refund);
        pool.debitForRefund(ev.endpointSlug, ev.refund);  // -= balance, += totalRefunds
        actualRefund = ev.refund;
        // ep.total_refunds update via E1 resolution
    }
}
```

`pool.debitForRefund(slug, amount)` already mirrors BOTH the
`current_balance -= r` AND `total_refunds += r` mutations at lines 481-490
exactly (confirmed in PactPool.sol:121-130).

The `ep.total_refunds += actual_refund_lamports` (lines 493-499) is an
endpoint stat mutation — covered by E1 (see §Q5). [VERIFIED: settle_batch.rs:455-502]

**Step 10 — Status determination and event emission** (lines 267-268, 504-522)

Status starts optimistic: `status = Settled (0)` (line 267).
Downgrades: DelegateFailed (line 333), PoolDepleted (line 468, WP-05),
ExposureCapClamped (line 407, WP-05).

On the WP-04 happy path, status is always `Settled` (= 0) for successful
events and `DelegateFailed` (= 1) for revoked-delegate events.

The CallRecord write (lines 504-522) is the Solana truth source; EVM replaces
this with `emit CallSettled(...)` (§4#3 / E4).

**Complete WP-04 per-event order summary:**
1. Guards: `InvalidTimestamp`, `PremiumTooSmall`, `FeeRecipientArrayTooLong`
2. Endpoint snapshot: `getEndpoint(slug)` → fee_recipients; `RecipientCoverageMismatch`
3. Dedup: `mapping(bytes16 => bool)` check → `DuplicateCallId`; SET dedup immediately
4. Premium-in: `try transferFrom(agent, pool, premium)` → on catch: DelegateFailed, emit, continue
5. Pool credit: `pool.creditPremium(slug, premium)`
6. Endpoint stats: `ep.totalCalls++`, `ep.totalPremiums += premium`, `ep.totalBreaches++` if breach
7. Exposure accounting (WP-04 portion only): `ep.currentPeriodRefunds += actualRefund`
8. Fee fan-out: loop over fee_recipients, `pool.payout(dest, fee)`, `pool.debitForFees(slug, totalFee)`
9. Refund (breach, WP-04 = sufficient balance): `pool.payout(agent, refund)`, `pool.debitForRefund(slug, refund)`, `ep.totalRefunds += refund`
10. Emit `CallSettled(callId, slug, agent, premium, refund, actualRefund, status, breach, latencyMs, timestamp)`

---

### Q2 — Fee fan-out math: exact truncation in Solidity

Solana (lines 428-429):
```rust
let bps = fee_recipients_snapshot[j].bps as u128;
let fee_amount = (premium_lamports as u128 * bps / 10_000u128) as u64;
```

This is integer floor division: `(premium * bps) / 10000`, truncated toward
zero (Rust integer division). The cast to u64 is lossless because the result
cannot exceed `premium` which is already a u64.

Solidity equivalent (bit-identical):
```solidity
uint64 feeAmount = uint64(uint256(ev.premium) * ep.feeRecipients[j].bps / 10_000);
```

- `uint256(ev.premium)` promotes the u64 to prevent overflow in multiplication
  (`uint64.max * 10000 > uint64.max`, so the u128/u256 intermediate is
  necessary — same reason Rust uses u128).
- Solidity `/` is integer floor division (identical truncation behavior).
- Final `uint64(...)` downcast is safe: result <= premium <= 2^64-1.

Numeric verification from test "single event 10% Treasury":
- premium = 10_000; bps = 1000; fee = 10_000 * 1000 / 10_000 = 1_000. Pool net = 9_000.

Numeric verification from test "85/10/5":
- premium = 100_000; Treasury bps=1000: fee = 10_000; Affiliate bps=500: fee = 5_000.
  Pool residual = 100_000 - 15_000 = 85_000.

Numeric verification from test "mixed batch ep3 (1bps)":
- premium = 300_000; bps=1: fee = 300_000 * 1 / 10_000 = 30 (floor div). Pool = 299_970.

Zero-fee skip: `if (feeAmount == 0) continue;` — reproduced exactly. This
handles the case where `premium * bps < 10_000` (e.g., premium=99, bps=100:
fee=0, skip).

`totalFeePaid` accumulation uses `_ckAdd` (same pattern as PactPool) to
mirror `checked_add → ArithmeticOverflow`.

[VERIFIED: settle_batch.rs:426-453]

---

### Q3 — Premium-in mechanism: parity-faithful Solidity construct

Solana mechanism (lines 295-330): Because Pinocchio's CPI wrapper cannot
catch a failing `sol_invoke_signed_c` (the parent program is forced to fail),
the program CANNOT use try/catch. Instead it performs a MANUAL pre-flight:
reads the ATA buffer bytes directly to check delegate discriminant (offset 72),
delegate pubkey (offset 76-108), and `delegated_amount` (offset 121-128). If
the pre-flight fails, the CPI is skipped entirely and `status = DelegateFailed`.

EVM equivalent (§4#1, D-LOCK-3): Solidity try/catch on an external call.
The agent pre-approves `PactSettler` (not PactPool) as the ERC-20 spender for
the premium amount. `PactSettler` calls `transferFrom(agent, address(pool), premium)`.
The pool contract (`address(pool)`) is the ERC-20 custodian — confirmed by
`PactPool.topUp` which uses `safeTransferFrom(msg.sender, address(this), amount)`
and by `IPactPool` which holds `PoolState` keyed by slug.

**The critical implementation constraint:** Use a raw `IERC20` call inside
try/catch, NOT `SafeERC20.safeTransferFrom`. SafeERC20 converts any false
return value or revert into a Solidity revert, which would propagate out of
the catch block and abort the transaction. The raw ERC-20 interface allows the
try/catch to capture both `false` returns and reverts:

```solidity
try IERC20(usdc).transferFrom(ev.agent, address(pool), ev.premium) returns (bool ok) {
    if (!ok) revert DelegateFailed(); // treat false return as failure too
} catch {
    // status = DelegateFailed; continue
}
```

Wait — actually: if `transferFrom` returns `false`, the `try` branch executes
with `ok = false`. If `transferFrom` reverts, the `catch` branch fires. Both
map to `DelegateFailed` (no funds move). The implementation should handle both.

Funds flow: `transferFrom(agent, address(pool), premium)` — the pool contract
receives USDC directly. This is consistent with `PactPool.creditPremium` which
then updates the accounting ledger. The actual USDC token balance of
`address(pool)` increases from the `transferFrom`; `creditPremium` updates the
`PoolState.currentBalance` and `totalPremiums` in storage.

[VERIFIED: settle_batch.rs:295-355, PactPool.sol, design spec §4#1]

---

### Q4 — Dedup state on DelegateFailed: mapping IS set

From `settle_batch.rs` line 244-262: the CallRecord PDA is ALLOCATED (via
`create_account`) BEFORE the delegate pre-flight check at line 295. The
`create_account` call writes the account data unconditionally at this point.
The dedup check at line 194 (`!call_record_acct.is_data_empty()`) fires before
this, so after allocation the account is non-empty for any subsequent replay.

Then at lines 332-355: on `!premium_in_ok`, the record is written with
`settlement_status = DelegateFailed` and `continue`. So the call_id IS
committed to the dedup store even when the event fails with DelegateFailed.

EVM mapping: `_settledCallIds[ev.callId] = true` MUST be set BEFORE the
try/catch for premium-in, so that a DelegateFailed event also marks the
call_id as seen. The `mapping(bytes16 => bool)` write happens at Step 3 in
the order above (immediately after the dedup check passes), before Step 5
(premium-in). This is the parity-faithful behavior. [VERIFIED: settle_batch.rs:194-196, 248-262, 332-355]

---

### Q5 — Stats accounting and E1 (OPEN — characterize only, do NOT resolve)

**Every EndpointConfig field settle_batch.rs mutates in the happy path:**

| Field | Solana line(s) | Arithmetic | WP scope |
|-------|---------------|------------|----------|
| `ep.total_calls` | 385 | `checked_add(1)` | WP-04 |
| `ep.total_premiums` | 387-389 | `checked_add(premium_lamports)` | WP-04 |
| `ep.total_breaches` | 391-394 | `checked_add(1)` if breach | WP-04 |
| `ep.current_period_start` | 397-398 | reset to `now` (only if period expired) | WP-05 |
| `ep.current_period_refunds` | 410-414 | `checked_add(intended_refund)` | WP-04 (additive path) |
| `ep.total_refunds` | 496-499 | `checked_add(actual_refund_lamports)` | WP-04 |

**E1 Problem Statement:**

`IPactRegistry.EndpointConfig` already declares all these fields:
`totalCalls`, `totalBreaches`, `totalPremiums`, `totalRefunds`,
`currentPeriodStart`, `currentPeriodRefunds`. These live in `PactRegistry`
storage (WP-02 contract). `IPactRegistry` exposes `getEndpoint(slug)` (read)
but has NO settler-gated write path for these stats. WP-03 D1 stated "NO
modification of committed WP-02 PactRegistry" — this constraint was scoped to
WP-03's pool-existence check, but the D1 text is broad.

**Candidate resolutions (for captain — do NOT implement until E1 is ruled):**

**(a) Extend PactRegistry with SETTLER_ROLE-gated stat-update hooks**
- Add `updateEndpointStats(bytes16 slug, ...)` or individual hooks (e.g.,
  `recordCall(bytes16 slug, uint64 premium, bool breach, uint64 refund)`)
  guarded by `onlyRole(SETTLER_ROLE)` on `PactRegistry` (same pattern as
  WP-03 pool hooks on `PactPool`).
- Pros: spec-§6-faithful (EndpointConfig is registry state), §4#5-symmetric
  (SETTLER_ROLE pattern), indexer sees consistent state from one contract,
  `getEndpoint()` returns live stats.
- Cons: modifies the committed WP-02 `PactRegistry` (requires re-running
  WP-02 tests to confirm they remain green).
- **This is the only spec-§6-faithful option.** The handoff §(g)#3-6
  explicitly lists `ep.total_calls`, `ep.total_premiums`, `ep.total_breaches`,
  `ep.total_refunds` as WP-04 mutations. The D1 "no-modify" was scoped to
  WP-03's concerns (pool-existence vs registry coupling), not WP-04's settler
  stat hooks.

**(b) Hold endpoint settlement-stats in PactSettler storage**
- `mapping(bytes16 => EndpointStats)` inside `PactSettler`.
- Pros: no modification to WP-02 contracts; isolated.
- Cons: splits state — `getEndpoint()` returns stale/zero stats; indexer must
  read two contracts to reconstruct full endpoint state; diverges from
  design-spec §6 (EndpointConfig is the registry's concern); creates
  permanent architectural split.

**(c) Accept partial stats parity for WP-04**
- Implement `PactSettler`-local accumulators that are only exposed via events,
  not storage; WP-06 parity matrix marks these as OPTIMIZED-DIVERGENCE.
- Pros: no WP-02 modification, minimal scope.
- Cons: `SET-07` requires "identical arithmetic and ordering" — this likely
  fails the requirement.

**Lead analysis:** Option (a) is the only spec-faithful choice. The planner
must record E1 as a GATE A decision and block the endpoint-stats task(s) on
the captain's ruling. SET-07 cannot be fully satisfied without E1 resolution.

---

### Q6 — CallRecord bytes → vm.expectEmit assertions (E4 mapping)

Solana `CallRecord` layout (state.rs, LEN=112):
```
offset 0:  bump        u8
offset 1:  breach      u8
offset 2:  settlement_status u8     → vm.expectEmit: status
offset 3-7: _padding0
offset 8-23: call_id [u8;16]
offset 24-55: agent    Address (32B)
offset 56-71: endpoint_slug [u8;16]
offset 72-79: premium_lamports u64
offset 80-87: refund_lamports u64   → vm.expectEmit: refund (intended)
offset 88-95: actual_refund_lamports u64 → vm.expectEmit: actualRefund
offset 96-99: latency_ms u32
offset 100-103: _padding1
offset 104-111: timestamp i64
```

Test assertions in `05-settle-batch.test.ts`:
- `cr[2]` = `settlement_status` byte → `CallSettled.status`
- `readU64(cr, 80)` = `refund_lamports` (intended) → `CallSettled.refund`
- `readU64(cr, 88)` = `actual_refund_lamports` → `CallSettled.actualRefund`

Foundry `vm.expectEmit` mapping:
```solidity
vm.expectEmit(true, true, true, true);
emit IPactSettler.CallSettled(
    ev.callId,                  // indexed: cr.call_id
    ev.endpointSlug,            // indexed: cr.endpoint_slug
    ev.agent,                   // indexed: cr.agent
    ev.premium,                 // cr.premium_lamports
    ev.refund,                  // cr.refund_lamports (intended)
    expectedActualRefund,       // cr.actual_refund_lamports
    IPactSettler.SettlementStatus.Settled,  // cr.settlement_status
    ev.breach,                  // cr.breach
    ev.latencyMs,               // cr.latency_ms
    ev.timestamp                // cr.timestamp
);
```

For "happy path: Settled (0)" test (callId fill(80)):
- `cr[2] == 0` → `status == Settled`
- `readU64(cr, 80) == 50_000` → `refund == 50_000`
- `readU64(cr, 88) == 50_000` → `actualRefund == 50_000`

For "DelegateFailed" test (callId fill(21)):
- `cr[2] == 1` → `status == DelegateFailed`
- (no balance assertions)

The `mapping(bytes16 => bool)` is the ONLY persisted per-call state. The
`CallSettled` event is the indexer truth source (§4#3). [VERIFIED: state.rs:168-198,
05-settle-batch.test.ts:347-351, 700-706]

---

### Q7 — SETTLER_ROLE gate (E2 characterization)

**Current scaffold state:** `PactSettler.sol` has a plain `address public settler`
and a 4-arg constructor `(usdc_, registry_, pool_, settler_)`. The
`settleBatch` function has no access guard (it just reverts `NOT_IMPLEMENTED`).
The scaffold comment says `TODO(WP-EVM-05)` for AccessControl, but the handoff
§(g)#8 and D-LOCK-3 §4#5 place it in WP-04 (required for "unauthorized settler
rejected" test). D-LOCK-1: scaffold TODO is a non-authoritative sketch; the
handoff supersedes it.

**Required changes to `PactSettler.sol` for E2:**
1. Add `import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol"`
2. Change `contract PactSettler is IPactSettler` to
   `contract PactSettler is IPactSettler, AccessControl`
3. Add `bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE")`
4. Add `onlyRole(SETTLER_ROLE)` modifier to `settleBatch`
5. Constructor changes: replace `address settler_` with no settler arg;
   grant `DEFAULT_ADMIN_ROLE` to `registry.authority()` (same as PactPool
   constructor pattern); remove `address public settler` storage var.
   OR: keep a constructor arg for the initial admin; grant `SETTLER_ROLE`
   to the deployed `PactSettler` address post-deploy (from the deployer).
6. `PactSettler` must be granted `PactPool.SETTLER_ROLE` — wired in
   `Deployment.t.sol` setUp (same pattern as `_grantSettler()` in PactPool.t.sol).

**Impact on `Deployment.t.sol`:** `test_DeployPactSettler` currently passes
`address(this)` as `settler_`. After E2, the constructor signature changes.
The test will need updating. The captain confirms this at GATE A.

**E2 lead resolution (from 04-CONTEXT.md):** WP-04 implements OZ
`AccessControl` `SETTLER_ROLE` on `PactSettler`; the deployed `PactSettler`
is granted `PactPool`'s `SETTLER_ROLE`. Captain confirms.

---

### Q8 — The 9 happy-path tests: exact setups and Foundry mappings

**Test toolchain confirmed:** forge-std is available (`import {Test} from "forge-std/Test.sol"`
used in PactPool.t.sol). `vm.prank`, `vm.expectRevert`, `vm.expectEmit`,
`makeAddr`, `assertEq`, `assertTrue` are all in the established pattern.
MockUSDC (6-decimal ERC-20, `mint(address, uint256)`) is at `test/util/MockUSDC.sol`.

New Foundry test file: `test/PactSettler.t.sol`

**Common setUp (mirrors every LiteSVM test setup):**
```solidity
MockUSDC usdc;
PactRegistry reg;
PactPool pool;
PactSettler settler;
address authority = makeAddr("authority");
address treasuryVault = makeAddr("treasuryVault");
address settlerSigner = makeAddr("settlerSigner");  // the SETTLER_ROLE holder

bytes16 constant SLUG_HELIUS = bytes16("helius");
bytes32 settlerRole;

function setUp() public {
    usdc = new MockUSDC();
    // mirrors setupProtocolAndTreasury: ProtocolConfig default = Treasury 1000bps
    IPactRegistry.FeeRecipient[8] memory d;
    d[0] = IPactRegistry.FeeRecipient({kind: 0, destination: treasuryVault, bps: 1000});
    reg = new PactRegistry(authority, address(usdc), treasuryVault, 3000, d, 1);
    pool = new PactPool(address(usdc), address(reg));
    settler = new PactSettler(address(usdc), address(reg), address(pool));
    // Grant PactSettler the pool's SETTLER_ROLE (E2 wiring)
    settlerRole = pool.SETTLER_ROLE();
    vm.prank(authority);
    pool.grantRole(settlerRole, address(settler));
    // Grant settlerSigner the PactSettler's SETTLER_ROLE
    vm.prank(authority);  // or whoever is DEFAULT_ADMIN of settler
    settler.grantRole(settler.SETTLER_ROLE(), settlerSigner);
}
```

**Helper functions to mirror from helpers.ts:**

| LiteSVM helper | Foundry equivalent |
|---------------|-------------------|
| `setupProtocolAndTreasury` | `setUp()` above |
| `registerSimpleEndpoint(base, slug)` | `_register(bytes16 slug)` — `vm.prank(authority); reg.registerEndpoint(...)` with default 500 flatPremium, 0 percentBps, 5000 slaMs, 1000 imputedCost, 5_000_000 exposureCap, false/0/empty recipients |
| `fundPoolDirect(svm, poolPda, poolVault, amount)` | `_fundPool(bytes16 slug, uint64 amount)` — `usdc.mint(authority, amount); vm.prank(authority); usdc.approve(address(pool), amount); vm.prank(authority); pool.topUp(slug, amount)` |
| `provisionAgent(svm, mint, saPda, balance, delegated)` | `_provisionAgent(uint64 amount)` — `usdc.mint(agent, amount); vm.prank(agent); usdc.approve(address(settler), amount)` |
| `buildSettleBatch(settler, saPda, events)` | direct `settler.settleBatch(events)` call with `vm.prank(settlerSigner)` |
| `getTokenBalance(svm, ata)` | `usdc.balanceOf(addr)` |
| `getAccountData(svm, crPda)` | N/A — no CallRecord; use `vm.expectEmit` on `CallSettled` |
| `readU64(cr, 80)` / `readU64(cr, 88)` | `CallSettled` event fields `refund` / `actualRefund` |

**Per-test mapping:**

**Test 1: "single event default 10% Treasury fan-out"** (callId fill(1))
Setup: register "helius" (default 1000bps Treasury); fundPool 5_000_000;
provisionAgent 10_000_000; premium=10_000; refund=0; breach=false.
Assertions:
- `usdc.balanceOf(agentAddr) == 10_000_000 - 10_000` (9_990_000)
- `usdc.balanceOf(address(pool)) == 5_000_000 + 9_000` (pool net +9_000 after 1_000 fee out)
- `usdc.balanceOf(treasuryVault) == 1_000`
- `pool.balanceOf(SLUG_HELIUS).currentBalance == 5_000_000 + 9_000`
- CallSettled emitted: status=Settled, refund=0, actualRefund=0

**Test 2: "explicit Treasury 10% + Affiliate 5% (85/10/5)"** (callId fill(2))
Setup: register "jupiter" with recipientsOverride [Treasury 1000bps, Affiliate 500bps];
fundPool 5_000_000; premium=100_000; refund=0; breach=false.
Assertions:
- `usdc.balanceOf(treasuryVault) == 10_000`
- `usdc.balanceOf(affAddr) == 5_000`
- `usdc.balanceOf(address(pool)) == 5_000_000 + 85_000`
- `usdc.balanceOf(agentAddr) == 10_000_000 - 100_000`

**Test 3: "breach event refunds agent ATA from pool vault"** (callId fill(3))
Setup: register "helius" default; fundPool 5_000_000; premium=1_000; refund=50_000;
breach=true; latencyMs=6000.
Assertions:
- `usdc.balanceOf(agentAddr) == 10_000_000 - 1_000 + 50_000`
- `usdc.balanceOf(address(pool)) == 5_000_000 + 1_000 - 100 - 50_000 == 4_950_900`
  (gross +1000, fee -100 (10% of 1000), refund -50000)
- `usdc.balanceOf(treasuryVault) == 100`
- CallSettled: status=Settled, refund=50_000, actualRefund=50_000

**Test 4: "mixed batch across 3 endpoints"** (callIds fill(11), fill(12), fill(13))
Setup: ep1 "ep1" default; ep2 "ep2" [Treasury 500bps + Affiliate 500bps]; ep3 "ep3"
[Treasury 1bps]; fundPool each 1_000_000; agent balance 30_000_000;
premiums [100_000, 200_000, 300_000]; all non-breach.
Assertions:
- `usdc.balanceOf(agentAddr) == 30_000_000 - 600_000`
- `pool.balanceOf("ep1").currentBalance == 1_000_000 + 90_000`
- `pool.balanceOf("ep2").currentBalance == 1_000_000 + 180_000`
- `pool.balanceOf("ep3").currentBalance == 1_000_000 + 299_970`
- `usdc.balanceOf(treasuryVault) == 20_030` (10k+10k+30)
- `usdc.balanceOf(aff2Addr) == 10_000`

**Test 5: "revoke between events: DelegateFailed and continues"** (callIds fill(20), fill(21))
Setup: register "helius"; fundPool; provisionAgent.
- First batch (callId fill(20), premium=1_000): succeeds.
- Revoke: `vm.prank(agentAddr); usdc.approve(address(settler), 0)` (zero allowance).
- Second batch (callId fill(21), premium=1_000): must NOT revert as a tx.
Assertions on second batch result:
- `usdc.balanceOf(agentAddr) == balanceAfterFirst` (unchanged)
- CallSettled emitted with status=DelegateFailed
- `_settledCallIds[fill(21)] == true` (dedup set even on failure)

**Test 6: "min-premium edge: premium < MIN_PREMIUM rejected"** (callId fill(30))
Setup: register "helius"; fundPool; provisionAgent; premium=50 (< 100).
Assertion: `vm.expectRevert(PremiumTooSmall.selector); settler.settleBatch(events)`

**Test 7: "duplicate call_id rejected"** (callId fill(40))
Setup: register "helius"; fundPool; provisionAgent.
- First settle: succeeds.
- Second settle with same callId:
Assertion: `vm.expectRevert(DuplicateCallId.selector)`

**Test 8: "unauthorized settler rejected"** (callId fill(50))
Setup: register "helius"; fundPool; provisionAgent.
- Call `settler.settleBatch(events)` with `vm.prank(makeAddr("fake"))`.
Assertion: `vm.expectRevert(IAccessControl.AccessControlUnauthorizedAccount.selector, ...)`
(mirrors PactPool.t.sol `test_Hooks_RejectNonSettler` pattern)

**Test 9: "happy path: CallRecord settlement_status = Settled (0)"** (callId fill(80))
Setup: register "helius"; fundPool 5_000_000; provisionAgent; premium=1_000;
refund=50_000; breach=true.
Assertions via CallSettled event:
- `CallSettled.status == Settled (0)`
- `CallSettled.refund == 50_000`
- `CallSettled.actualRefund == 50_000`
(mirrors `cr[2]==0, readU64(cr,80)==50_000, readU64(cr,88)==50_000`)

---

### Q9 — PORT vs N-A-ON-EVM analysis for 05 happy-path tests

All 9 happy-path tests PORT. The following Solana-platform assertions within
them are N-A-ON-EVM:

| Assertion | Rationale | Status |
|-----------|-----------|--------|
| `deriveCallRecord(callId)` PDA derivation | Solana PDA; EVM uses `mapping(bytes16 => bool)` dedup — no per-call account | N-A-ON-EVM |
| `getAccountData(svm, crPda) != null` (CallRecord exists) | No `CallRecord` account on EVM (§4#3) | N-A-ON-EVM (replaced by CallSettled event) |
| `cr[2]` byte-offset status read | Bytemuck/byte-layout assertion; EVM uses typed event field | N-A-ON-EVM (ports to `CallSettled.status`) |
| `readU64(cr, 80)` / `readU64(cr, 88)` byte reads | Same — byte offset reads into a PDA account | N-A-ON-EVM (ports to `CallSettled.refund` / `CallSettled.actualRefund`) |
| `is_data_empty()` dedup check | PDA account existence check; EVM uses `mapping(bytes16 => bool)` | N-A-ON-EVM (mechanism divergence, behavior preserved) |
| SPL Token delegate pre-flight byte checks | SPL Token ATA buffer introspection; EVM uses ERC-20 allowance | N-A-ON-EVM (replaced by try/catch transferFrom) |
| `SettlementAuthority` PDA signer match | Pinocchio signer check; EVM uses SETTLER_ROLE | N-A-ON-EVM (mechanism divergence §4#5) |
| `!settler_signer.is_signer()` account signer flag | Solana account model; EVM has no equivalent | N-A-ON-EVM |
| `pool_vault` USDC vault ATA binding check | Per-pool vault account; EVM pool is the vault | N-A-ON-EVM |
| `ProgramError::NotEnoughAccountKeys` | Solana account array size guard | N-A-ON-EVM |
| `ProgramError::InvalidSeeds` | PDA derivation verification | N-A-ON-EVM |

All economic/balance/status assertions PORT directly.

---

### Q10 — Test toolchain specifics

**forge-std:** Available at `lib/forge-std/src/` per foundry.toml remapping.
`Test.sol` import confirmed in PactPool.t.sol.

**MockUSDC:** `test/util/MockUSDC.sol` — 6-decimal OZ ERC20, `mint(address, uint256)`.
For WP-04, also needs `approve` (standard OZ ERC20) and `balanceOf`. All
present via OZ inheritance.

**foundry.toml remappings:**
- `forge-std/=lib/forge-std/src/`
- `@openzeppelin/=lib/openzeppelin-contracts/`

**Solidity version:** `^0.8.30`, evm_version: `prague`.

**Role grant pattern (from PactPool.t.sol):**
```solidity
bytes32 settlerRole = pool.SETTLER_ROLE();  // cache BEFORE vm.prank
vm.prank(authority);                          // DEFAULT_ADMIN_ROLE holder
pool.grantRole(settlerRole, settler);
```
For WP-04, the wiring is two-layer:
1. Grant `PactPool.SETTLER_ROLE` to `address(settler)` (PactSettler contract).
2. Grant `PactSettler.SETTLER_ROLE` to the test's `settlerSigner` address.

**vm.prank discipline:** Cache `SETTLER_ROLE` constant before any `vm.prank`
call — a single-shot prank would be consumed by the `pool.SETTLER_ROLE()`
external call if not cached. This is the established pattern.

**vm.expectEmit:** Use before the `settleBatch` call for `CallSettled` event
assertions:
```solidity
vm.expectEmit(true, true, true, true);  // all topics + data
emit IPactSettler.CallSettled(callId, slug, agent, premium, refund, actualRefund, status, breach, latencyMs, timestamp);
vm.prank(settlerSigner);
settler.settleBatch(events);
```

**E3 consolidation note (from 04-CONTEXT.md):** Two `CallSettled` declarations
exist: `IPactSettler.CallSettled` (status as `SettlementStatus` enum) and
`PactEvents.CallSettled` (status as `uint8`). Lead resolution: `PactSettler`
emits the `IPactSettler` typed-enum event. Tests should import and assert
against `IPactSettler.CallSettled`. Captain confirms at GATE A.

---

## Standard Stack

### Core (all already in the project)
| Library | Version | Purpose | Source |
|---------|---------|---------|--------|
| OpenZeppelin Contracts | `lib/openzeppelin-contracts/` | AccessControl, IERC20, SafeERC20 | [VERIFIED: foundry.toml, PactPool.sol imports] |
| forge-std | `lib/forge-std/src/` | Test, vm cheatcodes | [VERIFIED: foundry.toml, PactPool.t.sol] |
| solc | 0.8.30 | Compiler | [VERIFIED: foundry.toml] |

No new dependencies required for WP-04.

---

## Architecture Patterns

### PactSettler.sol — post-WP-04 structure

```solidity
contract PactSettler is IPactSettler, AccessControl {
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    address public immutable usdc;
    address public immutable registry;
    IPactPool public immutable pool;
    mapping(bytes16 => bool) private _settledCallIds;

    constructor(address usdc_, address registry_, address pool_) {
        usdc = usdc_;
        registry = registry_;
        pool = IPactPool(pool_);
        _grantRole(DEFAULT_ADMIN_ROLE, IPactRegistry(registry_).authority());
    }

    function settleBatch(SettlementEvent[] calldata events)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        // per-event loop
    }
}
```

Note: The 4-arg constructor in the scaffold becomes a 3-arg constructor once
the plain `address settler` is replaced by AccessControl. `Deployment.t.sol`
must be updated accordingly (confirmed change under E2).

### Per-event loop structure

```solidity
for (uint256 i = 0; i < events.length; i++) {
    SettlementEvent calldata ev = events[i];
    IPactSettler.SettlementStatus status = IPactSettler.SettlementStatus.Settled;
    uint64 actualRefund = 0;

    // Step 2: Guards (hard revert)
    // Step 3: Endpoint snapshot
    // Step 4: Dedup check + set
    // Step 5: Premium-in try/catch
    //   on catch: emit CallSettled(DelegateFailed), continue
    // Step 6: pool.creditPremium
    // Step 7: Endpoint stats (E1 gated)
    // Step 8: Fee fan-out loop
    // Step 9: Refund (breach, happy path)
    // Step 10: emit CallSettled
}
```

### Fee fan-out internal helper (mirroring checked_add pattern)

```solidity
function _ckAdd(uint64 a, uint64 b) private pure returns (uint64 c) {
    unchecked { c = a + b; }
    if (c < a) revert ArithmeticOverflow();
}
```

Same pattern as `PactPool._ckAdd`. Can be duplicated or extracted to a shared
library (Claude's discretion per 04-CONTEXT.md).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ERC-20 safe transfers (pool operations) | Custom transfer wrapper | `SafeERC20` (already in PactPool) | Handles non-standard return values |
| Access control | Custom role bitmaps | OZ `AccessControl` | Already used in PactPool, audit-familiar |
| Premium-in failure capture | Custom pre-flight byte checks | try/catch on raw `IERC20.transferFrom` | EVM-idiomatic; no ATA buffer to read |
| Fee-split integer precision | Custom fixed-point | `uint256` intermediate + floor div | Exact Solana parity; no precision loss |

---

## Common Pitfalls

### Pitfall 1: Using SafeERC20 for premium-in transferFrom
**What goes wrong:** `SafeERC20.safeTransferFrom` reverts on false return, so
the revert propagates out of any try/catch and the DelegateFailed recovery
path is never reached.
**How to avoid:** Use raw `IERC20(usdc).transferFrom(...)` in the try/catch.
**Warning signs:** "revoke between events" test fails with the whole tx reverting
instead of DelegateFailed being emitted.

### Pitfall 2: Setting dedup mapping AFTER premium-in attempt
**What goes wrong:** DelegateFailed events are not deduplicated; a revoked
agent can retry indefinitely.
**How to avoid:** Set `_settledCallIds[ev.callId] = true` at Step 3 (after
dedup check, before premium-in try/catch).
**Source authority:** settle_batch.rs:248-262 allocates the CallRecord PDA
before the delegate pre-flight check.

### Pitfall 3: Wrong `vm.prank` consumption order
**What goes wrong:** Caching `pool.SETTLER_ROLE()` inside a `vm.prank` block
consumes the prank on the external view call, not the intended state-changing
call.
**How to avoid:** Cache `settlerRole = pool.SETTLER_ROLE()` in setUp() before
any pranks (established pattern in PactPool.t.sol line 42-43).

### Pitfall 4: uint64 overflow on fee accumulation without _ckAdd
**What goes wrong:** `totalFeePaid += feeAmount` without overflow check allows
silent wrapping on large batches.
**How to avoid:** Use `totalFeePaid = _ckAdd(totalFeePaid, feeAmount)` mirroring
`checked_add → ArithmeticOverflow`.

### Pitfall 5: Missing `if (totalFeePaid > 0)` guard before debitForFees
**What goes wrong:** Calling `pool.debitForFees(slug, 0)` triggers an
unnecessary external call; more importantly, zero-fee endpoints (all bps
rounds to 0) skip this correctly in Solana.
**Source authority:** settle_batch.rs:446 `if total_fee_paid > 0`.

### Pitfall 6: Misidentifying the fee fan-out loop boundary
**What goes wrong:** Iterating `ep.feeRecipientCount` instead of `ev.feeRecipientCountHint`
for the fee payout loop. The hint is validated against the stored count at
Step 3, so they are equal — but the loop should use the verified `ep.feeRecipientCount`.
**Source authority:** settle_batch.rs:200-215 validates hint == stored count, then line 427 iterates `ep_count`.

### Pitfall 7: Contamination check
**What goes wrong:** If `CLAUDE.md` shows ` M` or `.claude/skills/pact/`
appears in the working tree, the working tree is contaminated.
**How to avoid:** Check `git status` before any commit; stop and report if
unexpected modifications appear (D-LOCK-6).

---

## OPEN Items — GATE A Decisions

These MUST be recorded in the PLAN as blocking decisions. Do NOT implement
until the captain rules.

### E1 — Endpoint-stats write path (PRIMARY GATE)
`settle_batch.rs` mutates 6 `EndpointConfig` fields (see §Q5 table).
`IPactRegistry` has no SETTLER_ROLE-gated write path. Three candidates:
(a) extend `PactRegistry` with stat hooks — spec-faithful, recommended;
(b) hold stats in `PactSettler` storage — architectural split, spec-divergent;
(c) no stats persistence — fails SET-07.
**Plan must block endpoint-stats tasks on E1 ruling.**

### E2 — SETTLER_ROLE gate location
Scaffold has plain `address settler`; WP-04 needs OZ AccessControl.
Lead: WP-04 implements AccessControl on `PactSettler`, changes constructor
from 4-arg to 3-arg, grants `DEFAULT_ADMIN_ROLE` to `registry.authority()`.
`Deployment.t.sol` `test_DeployPactSettler` must be updated.
**Plan must show Deployment.t.sol update as part of the E2 task.**

### E3 — CallSettled event consolidation
Two `CallSettled` declarations: `IPactSettler.CallSettled` (enum status) and
`PactEvents.CallSettled` (uint8 status). Lead: emit `IPactSettler` event only.
**Planner records; captain confirms.**

### E4 — CallRecord → event-as-truth
No `CallRecord` on EVM. Byte-level assertions (`cr[2]`, `readU64(cr,80)`,
`readU64(cr,88)`) port to `vm.expectEmit` on `CallSettled` fields.
**Planner records; captain confirms.**

---

## Environment Availability

Step 2.6: No new external dependencies. forge + OZ + forge-std are already
installed and confirmed working (70/70 tests green per handoff).

| Dependency | Required By | Available | Notes |
|------------|------------|-----------|-------|
| forge (Foundry 1.3.2) | All Solidity tasks | confirmed | `forge build` clean, 70 tests green |
| OpenZeppelin | AccessControl, IERC20, SafeERC20 | confirmed | `lib/openzeppelin-contracts/` |
| forge-std | Test harness | confirmed | `lib/forge-std/src/` |
| MockUSDC | Test USDC | confirmed | `test/util/MockUSDC.sol` |

No missing dependencies.

---

## Validation Architecture

Per D-LOCK-2: Strict TDD — write failing test, confirm RED, implement, confirm
GREEN. No Nyquist/security ceremony (disabled per D-LOCK-2).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | forge-std (Foundry 1.3.2) |
| Config file | `packages/program-evm/protocol-evm-v1/foundry.toml` |
| Quick run command | `forge test --match-contract PactSettlerTest` |
| Full suite command | `forge test` (must keep all 70 existing tests green) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Name | Automated Command |
|--------|----------|-----------|-------------------|
| SET-01 | Unauthorized caller reverts | `test_UnauthorizedSettlerRejected` | `forge test --match-test test_UnauthorizedSettlerRejected` |
| SET-02 | DelegateFailed on revoked allowance, batch continues | `test_RevokeMarksDelegateFailedAndContinues` | `forge test --match-test test_RevokeMarksDelegateFailedAndContinues` |
| SET-03a | PremiumTooSmall | `test_MinPremiumEdgeRejected` | `forge test --match-test test_MinPremiumEdgeRejected` |
| SET-03b | RecipientCoverageMismatch | (inline guard within integration tests) | included in full suite |
| SET-04 | DuplicateCallId | `test_DuplicateCallIdRejected` | `forge test --match-test test_DuplicateCallIdRejected` |
| SET-05 | Fee fan-out 10% default | `test_SingleEventDefaultTreasuryFanOut` | `forge test --match-test test_SingleEventDefaultTreasuryFanOut` |
| SET-05 | Fee fan-out 85/10/5 | `test_SingleEventExplicit85_10_5Split` | `forge test --match-test test_SingleEventExplicit85_10_5Split` |
| SET-05 | Mixed 3-endpoint batch | `test_MixedBatch3Endpoints` | `forge test --match-test test_MixedBatch3Endpoints` |
| SET-06 | Breach refund happy path | `test_BreachRefundsAgentFromPool` | `forge test --match-test test_BreachRefundsAgentFromPool` |
| SET-07 | Stats accounting | (verified via pool.balanceOf assertions in each test) | included in full suite |
| SET-08 | CallSettled event per call | `test_HappyPathSettledStatusEvent` | `forge test --match-test test_HappyPathSettledStatusEvent` |

### Wave 0 Gaps (test infrastructure needed before implementation)
- [ ] `test/PactSettler.t.sol` — the entire test file (does not exist yet)
- [ ] `PactSettler.sol` AccessControl refactor — constructor change affects
      `Deployment.t.sol` `test_DeployPactSettler` (Wave 0 fix)

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `IPactRegistry(registry_).authority()` is callable from PactSettler constructor for DEFAULT_ADMIN_ROLE grant (same pattern as PactPool) | Q7 | Low — PactPool already does this with no issues |
| A2 | `pool.balanceOf(slug).currentBalance` reflects the actual USDC balance after `transferFrom` + `creditPremium` (i.e., `PoolState.currentBalance` is the accounting ledger, not derived from `IERC20.balanceOf(address(pool))`) | Q3 | Low — confirmed by PactPool.t.sol tests |
| A3 | The `PactEvents.CallSettled` interface will be left as-is (E3 — emit only from IPactSettler, no second emission) | Q10/E3 | Low — captain rules E3 at GATE A |

---

## Sources

### Primary (HIGH confidence — directly verified from source files)
- `settle_batch.rs` (all line refs in this document) — parity authority
- `state.rs` — field widths, CallRecord layout, SettlementStatus enum
- `constants.rs` — MIN_PREMIUM=100, MAX_BATCH_SIZE=50, MAX_FEE_RECIPIENTS=8
- `error.rs` — PactError variants
- `05-settle-batch.test.ts` — exact numeric assertions for all 9 tests
- `helpers.ts` — provisionAgent, fundPoolDirect, buildSettleBatch patterns
- `PactPool.sol` — creditPremium/debitForFees/debitForRefund/payout implementations
- `IPactRegistry.sol` — EndpointConfig fields including stats fields
- `PactPool.t.sol` — role grant pattern, vm.prank discipline, MockUSDC usage
- `foundry.toml` — toolchain config and remappings
- `04-CONTEXT.md` — locked decisions and OPEN items

### Secondary (HIGH confidence — design docs read and cross-verified)
- `2026-05-15-arc-parity-port-design.md` §3/§4/§6/§8
- `2026-05-18-arc-evm-port-handoff.md` — 7 LOCKED rulings

---

## Metadata

**Confidence breakdown:**
- Per-event order and line refs: HIGH — directly read from settle_batch.rs
- Fee math: HIGH — verified against all three test numeric cases
- Premium-in mechanism: HIGH — verified from settle_batch.rs commentary (lines 280-314) and §4#1
- Dedup-on-failure: HIGH — verified from lines 248-262 (CallRecord allocation before pre-flight)
- E1-E4 characterization: HIGH — derived from source + existing EVM contracts
- Test numeric assertions: HIGH — read directly from 05-settle-batch.test.ts

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (stable domain — Solana source is the immutable authority)
