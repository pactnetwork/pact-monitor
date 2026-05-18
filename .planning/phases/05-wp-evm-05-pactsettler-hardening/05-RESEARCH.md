# Phase 5: WP-EVM-05 PactSettler Hardening - Research

**Researched:** 2026-05-18
**Domain:** EVM/Solidity behavioral-parity port — clamps, kill-switches, batch-limit enforcement
**Confidence:** HIGH (all claims re-derived directly from Rust source + live EVM code read)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- D-LOCK-1: `settle_batch.rs` / `pause_protocol.rs` / `pause_endpoint.rs` are the sole parity authority. Rust source beats any spec/plan/sketch conflict.
- D-LOCK-2: Strict TDD — write failing Foundry test, confirm RED, implement, confirm GREEN. Never skip RED.
- D-LOCK-3: Divergence ledger closed. §4#1 try/catch DelegateFailed; §4#2 mapping slug; §4#3 events as truth; §4#5 OZ AccessControl SETTLER_ROLE; §4#6 3 Solana initialize_* collapse into PactRegistry.
- D-LOCK-4: WP-02/03/04 rulings stand. E1-E4 resolutions stand.
- D-LOCK-5: PORT vs N-A rule — PORT all scenarios whose behavior survives the §4 ledger; N-A-ON-EVM only for genuine Solana-platform mechanics; add source-enforced invariant test for each N-A.
- D-LOCK-6: Conventions — no emojis, conventional commits, pnpm+forge never npm, file-scoped commits, no push/PR until GATE B. Working tree: only `?? .claude/pr-reviews/` expected.
- D-LOCK-PREC: Per-event order LOCKED: guards (InvalidTimestamp/PremiumTooSmall/FeeRecipientArrayTooLong) → DuplicateCallId READ → **EndpointPaused** (WP-05 inserts HERE additively) → RecipientCoverageMismatch → dedup SET → premium-in.
- D-LOCK-CLAMP-ORDER: Code order = cap-clamp first (settle_batch.rs:400-408) then pool-check (settle_batch.rs:462-469). Final-status PRECEDENCE = PoolDepleted > ExposureCapClamped > Settled. currentPeriodRefunds accrues the clamped amount and is NOT rolled back on PoolDepleted.
- D-LOCK-PROTO-PAUSE: Protocol-paused = PRE-loop fast-revert, first statement in settleBatch body, before BatchTooLarge and the loop.
- D-LOCK-BATCH: `events.length > ArcConfig.MAX_BATCH_SIZE (50)` → BatchTooLarge; strictly greater (50 OK, 51 rejects); pre-loop after role/pause gates.
- D-LOCK-EXPCAP-NA: ExposureCapExceeded is N-A in the settle path — the cap CLAMPS to a status, never reverts "exceeded".

### OPEN — GATE A Parity Decisions (captain rules; planner records, does NOT resolve)

- P1: ExposureCapClamped status conveyance across the E1 split (inference mechanism, no-rollback, precedence).
- P3: protocol-paused vs onlyRole(SETTLER_ROLE) modifier-order divergence (OPTIMIZED-DIVERGENCE recommendation).

### Claude's Discretion (within parity)

- Internal layout of the WP-05 inserts (helper extraction, local naming) — provided economic outputs, mutation ORDER, and the LOCKED precedence match settle_batch.rs exactly and the WP-04 90/90 regression stays green.
- Foundry test-util reuse from the WP-04 PactSettler.t.sol harness.

### Deferred Ideas (OUT OF SCOPE)

- WP-06: TS client, fuzz/gas suite, parity-matrix doc, formal spec-defect corrections.
- WP-07: deploy/verify.
- Config: settlement threat-model/adversarial pass decision is flagged for GATE A report; Nyquist stays off.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SET-09 | Pool-depleted clamp → PoolDepleted status | settle_batch.rs:462-469 re-derived; PactSettler.sol:200-205 empty-if seam confirmed |
| SET-10 | Exposure-cap clamp → ExposureCapClamped; hourly window | settle_batch.rs:400-414 re-derived; PactRegistry.sol:265-271 seam confirmed; period-reset already WP-04 |
| SET-11 | Protocol-paused fast-revert; endpoint-paused per event | settle_batch.rs:99-115 and :209 re-derived; registry.protocolPaused() getter and ep.paused confirmed present |
| SET-12 | BatchTooLarge edge (batch <= MAX_BATCH_SIZE=50) | settle_batch.rs:132-135 re-derived; ArcConfig.MAX_BATCH_SIZE=50 confirmed |
</phase_requirements>

---

## Summary

WP-EVM-05 is a pure additive hardening pass over the WP-04 PactSettler. The four seams left clean in WP-04 are filled exactly as specified by `settle_batch.rs`. All Solana authority files have been read in full and all EVM current-state files confirmed. No source-vs-context conflicts were found; D-LOCK-CLAMP-ORDER and D-LOCK-PREC are both verified correct against the Rust source. The two GATE A decisions (P1 and P3) are framed below with their seam constraints and lead resolutions — they are NOT resolved here and MUST be captain-ruled before implementation.

The 90/90 forge regression is confirmed green as of the research session. `forge build` is clean. Working tree shows only `?? .claude/pr-reviews/` as expected — no contamination.

**Primary recommendation:** Fill the four seams additively; extend PactSettler.t.sol with the ported test scenarios; confirm RED before each GREEN. No WP-04 code is reordered or rewritten.

---

## Control-Flow Re-Derivation from settle_batch.rs

### Full Per-Batch Execution Order (source-verified)

Reading `settle_batch.rs` in full against the CONTEXT.md anchors. Every line reference is verified against the actual file content.

**PRE-LOOP (lines 75-141):**

1. `:75-97` — account count/data-length guards, settler_signer is_signer check (`MissingRequiredSignature`). These are N-A-on-EVM (PDA/signer mechanics).
2. `:99-115` — **PROTOCOL-PAUSED fast-revert.** `verify_protocol_config(protocol_config)` then read `pc.paused`; if `!= 0` return `PactError::ProtocolPaused`. This fires BEFORE any per-event work or token transfer. The EVM equivalent is `if (registry.protocolPaused()) revert ProtocolPaused();` as the FIRST statement in the settleBatch body.
3. `:117-130` — settler identity check (`sa.signer == settler_signer.address()` → `UnauthorizedSettler`). N-A-on-EVM (§4#5, already OZ `onlyRole(SETTLER_ROLE)` modifier which runs before the body — this is the P3 divergence).
4. `:132-135` — **BATCHTOOLARGE:** `event_count > MAX_BATCH_SIZE` → `BatchTooLarge`. Strictly greater: `> 50` (50 is accepted, 51 rejects). Fires AFTER the pause check, BEFORE the loop.
5. `:136-141` — data-length check, clock/rent. N-A-on-EVM.

**Source text at :132-135 (verbatim):**
```rust
let event_count = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
if event_count > MAX_BATCH_SIZE {
    return Err(PactError::BatchTooLarge.into());
}
```
`MAX_BATCH_SIZE = 50` per `constants.rs`. Confirmed: 50 OK, 51 rejects.

**PER-EVENT LOOP (lines 144-525):**

The LOCKED D-LOCK-PREC order, re-derived from source:

| Step | Source line | Guard/action | EVM current state |
|------|-------------|--------------|-------------------|
| 1 | :158 | `timestamp > now` → `InvalidTimestamp` | PactSettler.sol:71 — exists |
| 2 | :161 | `premium < MIN_PREMIUM_LAMPORTS` → `PremiumTooSmall` | PactSettler.sol:72 — exists |
| 3 | :164 | `fee_count_hint > MAX_FEE_RECIPIENTS` → `FeeRecipientArrayTooLong` | PactSettler.sol:73-74 — exists |
| 4 | :194 | dedup READ: `!call_record.is_data_empty()` → `DuplicateCallId` | PactSettler.sol:84 — exists |
| **WP-05** | **:209** | **`ep.paused != 0` → `EndpointPaused`** | **NOT in WP-04; inserts HERE** |
| 5 | :212-221 | `ep_count != fee_count_hint` → `RecipientCoverageMismatch` | PactSettler.sol:89-91 — exists |
| 6 | :248-262 | dedup SET (CallRecord allocated) | PactSettler.sol:98 — exists |
| 7 | :295-355 | premium-in (delegate pre-flight + CPI) | PactSettler.sol:106 — exists |

**Source text at :209 (verbatim, inside the ep borrow block):**
```rust
let ep: &EndpointConfig = bytemuck::from_bytes(&ep_data[..EndpointConfig::LEN]);
if ep.paused != 0 {
    return Err(PactError::EndpointPaused.into());
}
```

D-LOCK-PREC is confirmed correct by source. `EndpointPaused` fires AFTER the dedup READ (:194) and BEFORE `RecipientCoverageMismatch` (:213). The EVM insert is additive: after `if (_settledCallIds[ev.callId]) revert DuplicateCallId();` and before the `RecipientCoverageMismatch` check.

**EXPOSURE-CAP CLAMP (lines :380-415):**

```rust
let mut intended_refund_after_cap = refund_lamports;  // :380
// ... ep stats (totalCalls, totalPremiums, totalBreaches) ...
// :396-399 period reset (ALREADY WP-04)
if now > ep.current_period_start + 3600 {
    ep.current_period_start = now;
    ep.current_period_refunds = 0;
}
// :400-408 CAP CLAMP (WP-05)
if intended_refund_after_cap > 0 {
    let cap_remaining = ep.exposure_cap_per_hour_lamports
        .saturating_sub(ep.current_period_refunds);
    if intended_refund_after_cap > cap_remaining {
        intended_refund_after_cap = cap_remaining;  // clamps (may become 0)
        status = SettlementStatus::ExposureCapClamped as u8;
    }
    // :409-414 accrual (ALREADY WP-04 — uses the POST-CAP amount)
    if intended_refund_after_cap > 0 {
        ep.current_period_refunds = ep.current_period_refunds
            .checked_add(intended_refund_after_cap)
            .ok_or(PactError::ArithmeticOverflow)?;
    }
}
```

Key verified facts:
- The clamp fires only when `intended_refund_after_cap > 0` (non-breach or zero-refund events skip entirely).
- `cap_remaining = saturating_sub(current_period_refunds)` — can be 0 when period budget is exhausted.
- Clamp fires when `intended > cap_remaining` (strictly greater). The `==` boundary means "not clamped" — intended equals cap_remaining, full amount passes.
- `status = ExposureCapClamped` is set at :407, INSIDE the cap-clamp block, BEFORE the pool-balance check at :462.
- `currentPeriodRefunds` accrues the POST-CAP (clamped) `intended_refund_after_cap` at :409-414. This is the WP-04 accrual line (`PactRegistry.sol:274-275`) — already exists and uses the returned value. The accrual is NOT rolled back if PoolDepleted fires later.

**POOL-BALANCE CHECK (lines :456-502):**

```rust
// :456-469
if intended_refund_after_cap > 0 {
    let pool_balance = {
        let pool_data = pool_acct.try_borrow()?;
        let cp: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
        cp.current_balance
    };
    if pool_balance < intended_refund_after_cap {
        // :468 PoolDepleted — OVERWRITES ExposureCapClamped if both fired
        status = SettlementStatus::PoolDepleted as u8;
        actual_refund_lamports = 0;
    } else {
        // transfer + debit + ep.total_refunds accrual
        actual_refund_lamports = intended_refund_after_cap;
        // ...
    }
}
```

Key verified facts:
- Pool-balance check is against the ALREADY cap-clamped `intended_refund_after_cap`, not the original `refund_lamports`.
- `status = PoolDepleted` is set at :468, AFTER :407 (`ExposureCapClamped`). So PoolDepleted OVERWRITES ExposureCapClamped when both fire.
- `ep.total_refunds` is only incremented (`:493-499`) inside the `else` branch — only when the refund is actually paid. The `recordRefundPaid` hook (WP-04) is called with `actualRefund` which is 0 on PoolDepleted, and the WP-04 code only calls `recordRefundPaid` when `actualRefund > 0` (`PactSettler.sol:217-221`) — correct, no change needed.

**D-LOCK-CLAMP-ORDER VERIFICATION:** Confirmed correct.
- Code order: cap-clamp (:400-408) THEN pool-check (:462-469).
- Final-status precedence: PoolDepleted (:468) > ExposureCapClamped (:407) > Settled (:267 default).
- No rollback of `currentPeriodRefunds` on PoolDepleted — the accrual at :409-414 is unconditional within its block and the pool-balance check comes after.

---

## P1 Framing: ExposureCapClamped Status Conveyance Across the E1 Split

**Status: OPEN — captain rules at GATE A. Do NOT silently implement.**

**The structural problem:** In Solana, `status = ExposureCapClamped` (:407) is set inside the same ep-borrow block that performs the clamp — the status local lives in `settle_batch.rs`. On EVM, the E1 split (WP-04, LOCKED) moves the ep mutation into `PactRegistry.recordCallAndCapAccrual`, which returns only `uint64 payableRefund`. The `SettlementStatus` local lives in `PactSettler._settleSuccess`, not in `PactRegistry`. The `_settleSuccess` call site is pinned UNCHANGED by handoff §d seam #1.

**The seam constraint:** `recordCallAndCapAccrual` signature is:
```solidity
function recordCallAndCapAccrual(
    bytes16 slug, uint64 premium, bool breach, uint64 intendedRefund
) external returns (uint64 payableRefund);
```
This is unchanged (WP-05 only adjusts what `payableRefund` returns; the call site in `_settleSuccess` is untouched).

**Lead resolution (seam-forced, not yet captain-ratified):**

`_settleSuccess` INFERS the clamp by comparing the returned `payableRefund` against the `intendedRefundAfterCap` it passed in:

```
payableRefund < intendedRefundAfterCap  ⟺  Solana's intended > cap_remaining
```

Proof of equivalence:
- Solana clamps when `intended > cap_remaining` and sets `intended = cap_remaining`.
- So returned value equals `cap_remaining` iff `intended > cap_remaining` (clamped).
- If `intended <= cap_remaining`, returned value equals `intended` (unchanged).
- The `==` boundary (`intended == cap_remaining`) means NOT clamped in both: Solana does not set ExposureCapClamped (condition is `>`, not `>=`); the inference also does not fire (`payableRefund == intendedRefundAfterCap`).
- Edge case: `intendedRefundAfterCap == 0` (non-breach) — the cap-clamp block in `settle_batch.rs` is guarded by `if intended_refund_after_cap > 0` (:400), so ExposureCapClamped can never fire; the inference `0 < 0` is false — correct.

**The no-rollback requirement (D-LOCK-CLAMP-ORDER):**
When PoolDepleted fires subsequently, `currentPeriodRefunds` stays at the clamped value — the accrual is already committed inside `recordCallAndCapAccrual`. The `PoolDepleted` branch sets `actualRefund = 0` but does NOT call `recordRefundPaid`. The `_settleSuccess` caller only calls `recordRefundPaid` when `actualRefund > 0` (WP-04, line 217). No rollback path exists or is needed — parity exact.

**The status local in `_settleSuccess`:**
The lead resolution would have `_settleSuccess` set a local `SettlementStatus status = SettlementStatus.Settled` and then, after the `recordCallAndCapAccrual` call:
```solidity
if (payableRefund < intendedRefundAfterCap) {
    status = SettlementStatus.ExposureCapClamped;
}
```
Then, in the PoolDepleted branch:
```solidity
status = SettlementStatus.PoolDepleted;  // overwrites ExposureCapClamped
```
This exactly mirrors the Solana code-order and final-status precedence.

**Captain decision required:** Ratify the inference mechanism, no-rollback, and precedence (analogous to WP-04 E1-E4). Do NOT change the seam-pinned call-site signature. Do NOT return an additional bool/enum from `recordCallAndCapAccrual`.

---

## P3 Framing: Protocol-Paused vs onlyRole(SETTLER_ROLE) Modifier Order Divergence

**Status: OPEN — captain rules at GATE A. Do NOT silently implement.**

**The structural problem:** Solidity modifiers execute before the function body. `settleBatch` is `onlyRole(SETTLER_ROLE)` (WP-04, LOCKED, E2). So an unauthorized caller hits `AccessControlUnauthorizedAccount` BEFORE the body's `ProtocolPaused` check.

**Solana order (from source):**
1. `:95-97` — `is_signer()` → `MissingRequiredSignature` (weak signer check)
2. `:99-115` — `pc.paused != 0` → `ProtocolPaused` (BEFORE full identity check)
3. `:117-130` — `sa.signer == settler_signer.address()` → `UnauthorizedSettler` (full identity check)
4. `:132-135` — `BatchTooLarge`

**The divergence:** For the corner case "caller lacks SETTLER_ROLE AND protocol is paused":
- Solana: returns `ProtocolPaused` (pause check fires before full identity check).
- EVM: returns `AccessControlUnauthorizedAccount` (modifier fires before body).

**For the operationally-real path** (authorized settler + protocol paused):
- Solana: `ProtocolPaused`.
- EVM: `ProtocolPaused`.
- These are IDENTICAL for the only case that matters in production.

**Lead resolution (seam-forced):**
Accept as OPTIMIZED-DIVERGENCE. The alternative — restructuring to an in-body `_checkRole` call placed after the pause check — would require rewriting the WP-04 `settleBatch` function signature and shape, which is forbidden (D-LOCK-6, no WP-04 reopen). Document in the WP-06 parity matrix. Port the parity-relevant path (authorized settler + paused → `ProtocolPaused`; resume after unpause → success).

**Captain decision required:** Ratify OPTIMIZED-DIVERGENCE vs the forbidden alternative.

---

## Seam Mechanics: Exact Additive Edits

All four seams are additive — no WP-04 code is reordered or removed.

### Seam 1: ExposureCapClamped — PactRegistry.sol:265-271

**Current state (WP-04, confirmed by read):**
```solidity
// PactRegistry.sol:260-263 — period reset (WP-04)
if (uint64(block.timestamp) > ep.currentPeriodStart + 3600) {
    ep.currentPeriodStart = uint64(block.timestamp);
    ep.currentPeriodRefunds = 0;
}
payableRefund = intendedRefund; // WP-04: NO clamp
// settle_batch.rs:400-408  (WP-05 cap-clamp DECISION) — clean additive seam
// [COMMENT AT :265-271 marks the exact insertion point]
// settle_batch.rs:409-414  (WP-04) — uses the post-cap amount
if (payableRefund > 0) {
    ep.currentPeriodRefunds = _ckAdd(ep.currentPeriodRefunds, payableRefund);
}
return payableRefund;
```

**WP-05 inserts (between line 264 and the accrual):**
```solidity
// settle_batch.rs:400-408
if (payableRefund > 0) {
    uint64 capRemaining = ep.exposureCapPerHour > ep.currentPeriodRefunds
        ? ep.exposureCapPerHour - ep.currentPeriodRefunds
        : 0;
    if (payableRefund > capRemaining) {
        payableRefund = capRemaining;
        // status = ExposureCapClamped conveyed by return value reduction
        // (P1 — captain ratifies inference in _settleSuccess)
    }
}
```
The `_settleSuccess` call site (`PactSettler.sol:168-174`) is UNCHANGED. The seam-comment at `:265-271` is replaced by the implementation.

Note: Solana uses `saturating_sub`. The EVM equivalent with `uint64` arithmetic is the ternary guard above (no underflow possible since both operands are `uint64`). The `_ckAdd` at `:274-275` for `currentPeriodRefunds` accrual already exists and uses the returned (now clamped) `payableRefund`.

### Seam 2: PoolDepleted — PactSettler.sol:200-205

**Current state (WP-04, confirmed by read):**
```solidity
if (ps.currentBalance < payableRefund) {
    // settle_batch.rs:462-469 PoolDepleted DECISION — WP-05.
    // Clean additive seam: WP-05 sets status=PoolDepleted &
    // actualRefund=0 HERE. WP-04 leaves this `if` EMPTY...
} else {
    pool.payout(ev.agent, payableRefund);
    pool.debitForRefund(ev.endpointSlug, payableRefund);
    actualRefund = payableRefund;
}
```

**WP-05 fills the empty if body:**
```solidity
if (ps.currentBalance < payableRefund) {
    status = SettlementStatus.PoolDepleted;
    actualRefund = 0;
} else {
    // ...unchanged WP-04 else...
}
```

This requires a `SettlementStatus status` local in `_settleSuccess` (currently the WP-04 emit hardcodes `SettlementStatus.Settled`). WP-05 introduces the local and makes the emit use it. The `recordRefundPaid` hook call at `:217` already guards `if (actualRefund > 0)` — PoolDepleted branch sets `actualRefund = 0` so the hook is correctly skipped. No WP-04 logic changes.

### Seam 3a: ProtocolPaused — PactSettler.settleBatch body head

**Current state (WP-04):** No protocol-paused check. The loop starts immediately after the `onlyRole(SETTLER_ROLE)` modifier.

**WP-05 inserts as FIRST statement in the function body:**
```solidity
if (registry.protocolPaused()) revert ProtocolPaused();
```
Then the BatchTooLarge check (seam 4), then the loop.

The `protocolPaused()` getter is confirmed present on `IPactRegistry` (line 69) and `PactRegistry` (line 36, `bool public override protocolPaused`). [VERIFIED: source read]

### Seam 3b: EndpointPaused — PactSettler.settleBatch per-event, D-LOCK-PREC slot

**Current state (WP-04, confirmed by read of PactSettler.sol:87-91):**
```solidity
if (_settledCallIds[ev.callId]) revert DuplicateCallId();  // :84

// Step 4: endpoint snapshot — settle_batch.rs:200-221.
// Endpoint-paused check (settle_batch.rs:209-211) is WP-05; skip.
IPactRegistry.EndpointConfig memory ep =
    IPactRegistry(address(registry)).getEndpoint(ev.endpointSlug);
if (ep.feeRecipientCount != ev.feeRecipientCountHint)
    revert RecipientCoverageMismatch();
```

**WP-05 inserts (after the getEndpoint call, before RecipientCoverageMismatch):**
```solidity
IPactRegistry.EndpointConfig memory ep =
    IPactRegistry(address(registry)).getEndpoint(ev.endpointSlug);
if (ep.paused) revert EndpointPaused();  // settle_batch.rs:209 — D-LOCK-PREC slot
if (ep.feeRecipientCount != ev.feeRecipientCountHint)
    revert RecipientCoverageMismatch();
```

The `EndpointPaused()` custom error is confirmed present in `PactErrors.sol` (line 23). The `ep.paused` field is confirmed `bool` in `IPactRegistry.EndpointConfig` (line 25). No WP-04 reordering — this is pure insertion.

### Seam 4: BatchTooLarge — PactSettler.settleBatch body head

**WP-05 inserts (after the ProtocolPaused check, before the loop):**
```solidity
if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();
```

`ArcConfig.MAX_BATCH_SIZE = 50` (uint16, confirmed). `events.length` is `uint256`; `> 50` with `MAX_BATCH_SIZE` promoted is correct. `BatchTooLarge()` confirmed in `PactErrors.sol` (line 31).

**Full WP-05 settleBatch head (post-insert):**
```solidity
function settleBatch(SettlementEvent[] calldata events)
    external
    override
    onlyRole(SETTLER_ROLE)
{
    if (registry.protocolPaused()) revert ProtocolPaused();
    if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();
    for (uint256 i = 0; i < events.length; i++) {
        // ...WP-04 loop body...
    }
}
```

---

## WP-02/03 Coverage Dedup: What PactRegistry.t.sol Already Covers

**Confirmed by full read of PactRegistry.t.sol (426 lines, 31 tests):**

### pause_endpoint.rs (06-pause.test.ts) — REGISTRY-SIDE

| Solana scenario | WP-02 test in PactRegistry.t.sol | Covered? |
|-----------------|----------------------------------|----------|
| 06:12 — sets paused flag | `test_PauseEndpoint_SetsPaused` | YES — covered |
| 06:34 — can unpause | `test_PauseEndpoint_CanUnpause` | YES — covered |
| 06:55 — rejected for non-authority | `test_PauseEndpoint_RejectsNonAuthority` | YES — covered |
| (bonus) unregistered slug | `test_PauseEndpoint_RejectsUnregistered` | YES — covered |

**Conclusion:** All registry-side 06-pause.test.ts scenarios are already covered by WP-02. WP-05 adds ONLY the settle-side `EndpointPaused` per-event enforcement (D-LOCK-PREC insert) — a new test in PactSettler.t.sol.

### pause_protocol.rs (10-pause-protocol.test.ts) — REGISTRY-SIDE

| Solana scenario | WP-02 test in PactRegistry.t.sol | Covered? |
|-----------------|----------------------------------|----------|
| 10:28 — toggles paused | `test_PauseProtocol_SetAndClear` | YES — covered |
| 10:72 — rejects non-authority | `test_PauseProtocol_RejectsNonAuthority` | YES — covered |
| 10:94 — rejects fake PC at wrong address | N-A-ON-EVM (PDA address spoof) | N-A |
| 10:128 — rejects PC at canonical addr, wrong owner | N-A-ON-EVM (PDA owner spoof) | N-A |

**Conclusion:** Registry-side toggle and authority-revert are covered by WP-02. WP-05 adds ONLY the settle-side ProtocolPaused enforcement tests (seam 3a scenarios) — new tests in PactSettler.t.sol.

---

## Test Port Plan: Scenario-by-Scenario

### New test file for WP-05

All WP-05 tests extend `PactSettler.t.sol`. No new test files are needed — the existing harness (setUp, _register, _fundPool, _provisionAgent, _makeEvent) is reused as-is.

### 05-settle-batch.test.ts: 4 deferred clamp/kill tests

**05:442 — pool depleted → PoolDepleted, refund skipped**

Source: Pool seeded with 100 units. Premium=1000, refund=200000. Pool balance (100 units) < intended refund (200000) after cap-clamp (cap is 5_000_000, so no cap-clamp fires). Status = PoolDepleted. ActualRefund = 0. Premium still charged (agent balance = -1000).

Foundry port:
```solidity
// RED: _settleSuccess emits Settled with actualRefund=payableRefund from else branch
// GREEN: PoolDepleted branch fills empty if
function test_PoolDepleted_RefundSkippedAndMarked() public {
    _register(SLUG);
    _fundPool(SLUG, 100);  // only 100 in pool
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
    events[0] = _makeEvent(0x3C, agent, SLUG, 1_000, 200_000, 6000, true, 1, 1);

    vm.expectEmit(true, true, true, true);
    emit IPactSettler.CallSettled(
        events[0].callId, SLUG, agent,
        1_000, 200_000, 0,
        IPactSettler.SettlementStatus.PoolDepleted,
        true, 6000, events[0].timestamp
    );
    vm.prank(settlerSigner);
    settler.settleBatch(events);

    // Agent paid premium, no refund received.
    assertEq(usdc.balanceOf(agent), 10_000_000 - 1_000);
}
```
cr[2]==2 byte-assert → `CallSettled.status == PoolDepleted`. readU64(cr,80)==200000 (refund) → `ev.refund`. readU64(cr,88)==0 (actual) → `actualRefund`.

**05:485 — exposure cap clamps → ExposureCapClamped, partial actualRefund**

Source: exposureCap=1000, refund=5000. cap_remaining=1000. intended > cap_remaining → clamped to 1000. Pool has 5_000_000 (sufficient). Status = ExposureCapClamped. actualRefund=1000. Agent net: -1000 premium + 1000 refund = 0.

Foundry port:
```solidity
// Register with exposureCap=1000 (use _registerWithExposureCap helper or direct)
function test_ExposureCapClamped_PartialActualRefund() public {
    // register with explicit exposureCapPerHour=1000
    IPactRegistry.FeeRecipient[8] memory none;
    vm.prank(authority);
    reg.registerEndpoint(SLUG_B, 500, 0, 5000, 1000, 1_000, false, 0, none);
    _fundPool(SLUG_B, 5_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
    events[0] = _makeEvent(0x46, agent, SLUG_B, 1_000, 5_000, 6000, true, 1, 1);

    vm.expectEmit(true, true, true, true);
    emit IPactSettler.CallSettled(
        events[0].callId, SLUG_B, agent,
        1_000, 5_000, 1_000,
        IPactSettler.SettlementStatus.ExposureCapClamped,
        true, 6000, events[0].timestamp
    );
    vm.prank(settlerSigner);
    settler.settleBatch(events);

    assertEq(usdc.balanceOf(agent), 10_000_000 - 1_000 + 1_000);
}
```
Depends on P1 captain ratification. Subject to GATE A ruling.

**05:529 — settle_batch rejects with ProtocolPaused when paused=1**

Source: pause protocol, attempt settleBatch → ProtocolPaused revert. No balances move. No callId consumed (dedup mapping not set — pause fires before per-event work).

Foundry port:
```solidity
function test_ProtocolPaused_RejectsSettleBatch() public {
    _register(SLUG);
    _fundPool(SLUG, 5_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    vm.prank(authority);
    registry.pauseProtocol(true);  // NB: registry, not settler

    uint256 agentBefore = usdc.balanceOf(agent);
    uint256 poolBefore  = usdc.balanceOf(address(pool));

    IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
    events[0] = _makeEvent(0x5A, agent, SLUG, 1_000, 0, 50, false, 1, 1);

    vm.prank(settlerSigner);
    vm.expectRevert(ProtocolPaused.selector);
    settler.settleBatch(events);

    // No balances moved.
    assertEq(usdc.balanceOf(agent), agentBefore);
    assertEq(usdc.balanceOf(address(pool)), poolBefore);
    // CallId NOT consumed (dedup mapping not set).
    // (EVM: no direct equivalent of "callRecord not created"; verify via retry succeeds after unpause)
}
```

Note: In EVM there is no CallRecord PDA existence check (mapping(bytes16 => bool) is the sentinel). The Solana test checks `getAccountData(base.svm, crPda) == null`. The EVM equivalent assertion is that the callId is NOT in `_settledCallIds` — which is private and not directly readable. The practical test is that a retry of the same callId SUCCEEDS after unpause (it is not consumed), which is verified in the resume test.

**05:595 — settle_batch resumes after pause → unpause**

Source: pause → attempt (fails) → unpause → second attempt with fresh callId (succeeds). CallRecord created after unpause.

Foundry port:
```solidity
function test_ProtocolPaused_ResumesAfterUnpause() public {
    _register(SLUG);
    _fundPool(SLUG, 5_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    vm.prank(authority);
    reg.pauseProtocol(true);

    // First attempt fails.
    IPactSettler.SettlementEvent[] memory ev1 = new IPactSettler.SettlementEvent[](1);
    ev1[0] = _makeEvent(0x5B, agent, SLUG, 1_000, 0, 50, false, 1, 1);
    vm.prank(settlerSigner);
    vm.expectRevert(ProtocolPaused.selector);
    settler.settleBatch(ev1);

    // Unpause.
    vm.prank(authority);
    reg.pauseProtocol(false);

    // Second attempt (fresh callId) succeeds.
    IPactSettler.SettlementEvent[] memory ev2 = new IPactSettler.SettlementEvent[](1);
    ev2[0] = _makeEvent(0x5C, agent, SLUG, 1_000, 0, 50, false, 1, 1);

    vm.expectEmit(true, true, true, true);
    emit IPactSettler.CallSettled(
        ev2[0].callId, SLUG, agent,
        1_000, 0, 0,
        IPactSettler.SettlementStatus.Settled,
        false, 50, ev2[0].timestamp
    );
    vm.prank(settlerSigner);
    settler.settleBatch(ev2);  // must NOT revert
}
```

### 06-pause.test.ts: Settle-side enforcement (registry-side already covered by WP-02)

Registry-side (set/unset, non-authority revert) are ALREADY in PactRegistry.t.sol. WP-05 adds only the settle-side enforcement:

**06: EndpointPaused per-event enforcement** (NO direct Solana test but derived from settle_batch.rs:209):
```solidity
function test_EndpointPaused_RevertsPerEvent() public {
    _register(SLUG);
    _fundPool(SLUG, 5_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    vm.prank(authority);
    reg.pauseEndpoint(SLUG, true);

    IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
    events[0] = _makeEvent(0x60, agent, SLUG, 1_000, 0, 50, false, 1, 1);

    vm.prank(settlerSigner);
    vm.expectRevert(EndpointPaused.selector);
    settler.settleBatch(events);
}

function test_EndpointPaused_CanResumeAfterUnpause() public {
    _register(SLUG);
    _fundPool(SLUG, 5_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    vm.prank(authority);
    reg.pauseEndpoint(SLUG, true);
    vm.prank(authority);
    reg.pauseEndpoint(SLUG, false);

    IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
    events[0] = _makeEvent(0x61, agent, SLUG, 1_000, 0, 50, false, 1, 1);
    vm.prank(settlerSigner);
    settler.settleBatch(events);  // must NOT revert
}
```

**06: EndpointPaused slots correctly in D-LOCK-PREC (after dedup READ, before RecipientCoverageMismatch):**
```solidity
// An event whose callId is already consumed AND endpoint is paused → DuplicateCallId wins
// (dedup READ fires before EndpointPaused — D-LOCK-PREC).
function test_EndpointPaused_DedupReadPrecedesEndpointPaused() public {
    _register(SLUG);
    _fundPool(SLUG, 5_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    // Consume callId while endpoint is live.
    IPactSettler.SettlementEvent[] memory ev1 = new IPactSettler.SettlementEvent[](1);
    ev1[0] = _makeEvent(0x62, agent, SLUG, 1_000, 0, 50, false, 1, 1);
    vm.prank(settlerSigner);
    settler.settleBatch(ev1);

    // Pause endpoint.
    vm.prank(authority);
    reg.pauseEndpoint(SLUG, true);

    // Replay same callId with endpoint paused → DuplicateCallId (not EndpointPaused).
    vm.prank(settlerSigner);
    vm.expectRevert(DuplicateCallId.selector);
    settler.settleBatch(ev1);
}
```

### 07-exposure-cap.test.ts

**07:25 — refund clamped to cap_remaining, marked ExposureCapClamped**

Two-batch scenario: cap=1_000_000. Batch 1: refund=600_000 (under cap) → full 600k paid, Settled. Batch 2: refund=500_000, cap_remaining=400_000 → clamped to 400k, ExposureCapClamped.

Port: Split into two separate tests or one multi-step test. Key assertions:
- After batch 1: `vm.expectEmit` on `CallSettled(Settled, refund=600000, actualRefund=600000)`.
- After batch 2: `vm.expectEmit` on `CallSettled(ExposureCapClamped, refund=500000, actualRefund=400000)`.
- Agent net: -500 - 500 + 600000 + 400000 = 999000.
- `ep.currentPeriodRefunds` after both: 1_000_000 (600k + 400k = cap).

Depends on P1. Subject to GATE A.

**07:81 — exposure cap resets after 1 hour**

Use existing WP-04 period-reset via `vm.warp`. Cap=500_000. Batch 1: full 500k used. `vm.warp(+7201)`. Batch 2: 500k again — period reset, cap_remaining=500_000, full amount passes (Settled). Both refunds paid.

Port:
```solidity
function test_ExposureCap_ResetsAfter1Hour() public {
    // register with exposureCapPerHour=500_000
    // ...fund pool...
    // batch 1: refund=500_000 → Settled, currentPeriodRefunds=500_000
    // vm.warp(uint256(reg.getEndpoint(SLUG).currentPeriodStart) + 3601)
    // batch 2: refund=500_000 → Settled (reset fired), currentPeriodRefunds=500_000
    // agent net: both refunds credited
}
```
Uses `vm.warp` (same pattern as WP-04 `test_EndpointStats_PeriodReset`). Does NOT re-implement the period reset — just asserts end-to-end through `settleBatch`.

### 09-auth-pda.test.ts: All N-A-ON-EVM

| Source scenario | Disposition | Surviving invariant |
|-----------------|-------------|---------------------|
| 09:47 — pause_endpoint rejects fake PC at wrong address | N-A-ON-EVM (PDA-address spoof; §4#2) | `pauseEndpoint` is `onlyAuthority` — already `test_PauseEndpoint_RejectsNonAuthority` |
| 09:78 — pause_endpoint rejects PC at canonical addr, wrong owner | N-A-ON-EVM (PDA-owner spoof; §4#6) | Same — `onlyAuthority` |
| 09:144 — update_endpoint_config rejects fake PC | N-A-ON-EVM (PDA-address spoof) | `updateEndpointConfig` is `onlyAuthority` — already `test_UpdateEndpointConfig_RejectsNonAuthority` |
| 09:172 — update_fee_recipients rejects fake Treasury | N-A-ON-EVM (Treasury PDA spoof; `treasuryVault` is immutable addr on EVM) | `updateFeeRecipients` is `onlyAuthority` — already `test_UpdateFeeRecipients_RejectsNonAuthority` |

All four surviving invariant tests are ALREADY COVERED by WP-02 `PactRegistry.t.sol`. WP-05 adds N-A rationale lines only (for WP-06 parity matrix). No new tests needed from 09.

One-line WP-06 matrix rationale for each: "PDA-address/owner spoofing is not possible on EVM — all privileged mutators are `onlyAuthority` (single `address authority` field); the authority-revert invariant is source-enforced and already tested in WP-02."

### 10-pause-protocol.test.ts

| Source scenario | Disposition | Notes |
|-----------------|-------------|-------|
| 10:28 — toggles paused | ALREADY WP-02 (`test_PauseProtocol_SetAndClear`) | Do NOT duplicate |
| 10:72 — rejects non-authority | ALREADY WP-02 (`test_PauseProtocol_RejectsNonAuthority`) | Do NOT duplicate |
| 10:94 — rejects fake PC at wrong address | N-A-ON-EVM (PDA-address spoof) | Surviving: `onlyAuthority` — WP-02 |
| 10:128 — rejects PC at canonical addr, wrong owner | N-A-ON-EVM (PDA-owner spoof) | Surviving: `onlyAuthority` — WP-02 |

WP-05 adds ONLY the settle-side enforcement tests (05:529, 05:595 above). Nothing from 10 needs new tests.

### BatchTooLarge: No Solana test → source-enforced invariant test

Per D-LOCK-5. No `05-settle-batch.test.ts` scenario tests BatchTooLarge directly (the Solana test infrastructure would be impractical for 51 events). WP-05 adds a source-enforced invariant test:

```solidity
function test_BatchTooLarge_51EventsRevert() public {
    _register(SLUG);
    _fundPool(SLUG, 5_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 10_000_000, 10_000_000);

    // 51 events (> MAX_BATCH_SIZE=50) → BatchTooLarge
    IPactSettler.SettlementEvent[] memory events =
        new IPactSettler.SettlementEvent[](51);
    for (uint8 i = 0; i < 51; i++) {
        events[i] = _makeEvent(i, agent, SLUG, 1_000, 0, 50, false, 1, 1);
    }
    vm.prank(settlerSigner);
    vm.expectRevert(BatchTooLarge.selector);
    settler.settleBatch(events);
}

function test_BatchTooLarge_50EventsAccepted() public {
    _register(SLUG);
    _fundPool(SLUG, 10_000_000);
    address agent = makeAddr("agent");
    _provisionAgent(agent, 100_000_000, 100_000_000);

    // 50 events (== MAX_BATCH_SIZE) → accepted (strictly greater rule)
    IPactSettler.SettlementEvent[] memory events =
        new IPactSettler.SettlementEvent[](50);
    for (uint8 i = 0; i < 50; i++) {
        events[i] = _makeEvent(i, agent, SLUG, 1_000, 0, 50, false, 1, 1);
    }
    vm.prank(settlerSigner);
    settler.settleBatch(events);  // must NOT revert
}
```

---

## SettlementStatus Local in _settleSuccess: Required WP-05 Introduction

WP-04's `_settleSuccess` emits `SettlementStatus.Settled` hardcoded (PactSettler.sol:235). WP-05 must introduce a `SettlementStatus status` local to allow ExposureCapClamped and PoolDepleted to be set and emitted. This is an additive change within `_settleSuccess` — the `settleBatch` loop and all WP-04 guard paths are unchanged.

The WP-04 emit at line 228-239 becomes:
```solidity
emit CallSettled(
    ev.callId, ev.endpointSlug, ev.agent,
    ev.premium, ev.refund, actualRefund,
    status,  // was hardcoded SettlementStatus.Settled
    ev.breach, ev.latencyMs, ev.timestamp
);
```

This is the ONLY change to the WP-04 emit path — replacing a literal with a local variable.

---

## OZ AccessControl Revert Selector for vm.expectRevert

The WP-04 harness already uses this pattern (confirmed in PactSettler.t.sol:317-322):

```solidity
vm.expectRevert(
    abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        callerAddress,
        roleBytes32
    )
);
```

Import required: `import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";` (already present in PactSettler.t.sol:5).

For simple custom errors (ProtocolPaused, EndpointPaused, BatchTooLarge, PoolDepleted, ExposureCapClamped) use the selector-only form:
```solidity
vm.expectRevert(ProtocolPaused.selector);
vm.expectRevert(EndpointPaused.selector);
vm.expectRevert(BatchTooLarge.selector);
```

---

## Test Runner Facts

**Working directory:** `packages/program-evm/protocol-evm-v1/` (absolute: `/Users/q3labsadmin/Q3/Solder/pact-network/packages/program-evm/protocol-evm-v1/`)

**Build:**
```bash
forge build
```
Current state: clean (build output: "No files changed, compilation skipped" with only an unused-import lint warning on ArcConfig in Deployment.t.sol — not an error). [VERIFIED: forge build run during research]

**Run full suite:**
```bash
forge test
```
Current: 90/90 green, 0 failed. [VERIFIED: forge test run during research]

**Run single test:**
```bash
forge test --match-test test_PoolDepleted_RefundSkippedAndMarked -vvv
```

**Run WP-05 tests only:**
```bash
forge test --match-test "test_PoolDepleted|test_ExposureCap|test_Protocol|test_EndpointPaused|test_BatchTooLarge" -vvv
```

**foundry.toml facts (confirmed):**
- `solc = "0.8.30"`, `evm_version = "prague"`, `optimizer = true`, `optimizer_runs = 200`
- `remappings`: `forge-std/` and `@openzeppelin/`
- No `fuzz` section (Nyquist off per config).

**Test count after WP-05:** 90 existing + ~12-14 new WP-05 tests = ~102-104 total. All 90 existing must stay green (regression gate).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Saturating subtraction | Custom clamp logic | Ternary `A > B ? A - B : 0` for uint64 (identical to saturating_sub) | Solana saturating_sub on uint64; EVM uint64 arithmetic; the ternary is idiomatic and safe |
| Overflow-checked add | Raw `+` | `_ckAdd` (already in PactRegistry.sol:232) | Matches Solana `checked_add → ArithmeticOverflow`; `_ckAdd` already exists |
| Time window | Custom clock | `block.timestamp` + `vm.warp` in tests | Same pattern as WP-04 period-reset test |
| AccessControl revert shape | Manual error encoding | `abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ...)` | WP-04 already uses this; reuse exactly |

---

## Common Pitfalls

### Pitfall 1: Introducing a status return from recordCallAndCapAccrual

**What goes wrong:** Adding a second return value (e.g., `bool clamped`) or an enum to `recordCallAndCapAccrual` to convey ExposureCapClamped status to `_settleSuccess`.
**Why it happens:** Temptation to avoid the inference comparison.
**How to avoid:** The seam is pinned UNCHANGED by handoff §d#1. The call site in `_settleSuccess` is not touched. Use the inference (`payableRefund < intendedRefundAfterCap`) pending P1 ratification.
**Warning signs:** Any diff touching `IPactRegistry.recordCallAndCapAccrual` return signature.

### Pitfall 2: Rolling back currentPeriodRefunds on PoolDepleted

**What goes wrong:** Adding `ep.currentPeriodRefunds -= payableRefund` in the PoolDepleted branch.
**Why it happens:** "The pool didn't pay, so the cap budget shouldn't be consumed."
**How to avoid:** D-LOCK-CLAMP-ORDER is explicit: no rollback. Solana :409-414 accrual is unconditional within the cap-clamp block and the pool-check comes later. The EVM accrual is already committed by `recordCallAndCapAccrual` returning before the pool check.
**Warning signs:** Any write to `currentPeriodRefunds` outside `recordCallAndCapAccrual`.

### Pitfall 3: Placing ProtocolPaused check after BatchTooLarge

**What goes wrong:** `if (events.length > MAX_BATCH_SIZE) revert BatchTooLarge();` before `if (registry.protocolPaused()) revert ProtocolPaused();`.
**Why it happens:** BatchTooLarge feels like a "cheaper" check.
**How to avoid:** settle_batch.rs order: pause check (:99-115) THEN batch size (:132-135). D-LOCK-PROTO-PAUSE is explicit.
**Warning signs:** BatchTooLarge appearing before ProtocolPaused in the body.

### Pitfall 4: EndpointPaused before the dedup READ

**What goes wrong:** Inserting `if (ep.paused) revert EndpointPaused();` BEFORE `if (_settledCallIds[ev.callId]) revert DuplicateCallId();`.
**Why it happens:** Wanting to "fail fast" on paused endpoints.
**How to avoid:** D-LOCK-PREC is strict: dedup READ (:194) precedes EndpointPaused (:209). The WP-04 DuplicateCallId test already pins this. A test (`test_EndpointPaused_DedupReadPrecedesEndpointPaused`) should catch this.
**Warning signs:** EndpointPaused revert before `_settledCallIds` check in per-event code.

### Pitfall 5: Emitting hardcoded Settled status after WP-05

**What goes wrong:** Forgetting to replace `SettlementStatus.Settled` literal in the WP-04 emit with the new `status` local.
**Why it happens:** The emit line is at the bottom of `_settleSuccess`; easy to miss.
**How to avoid:** The test `test_PoolDepleted_RefundSkippedAndMarked` using `vm.expectEmit` will fail RED with the wrong status — strict TDD catches this.
**Warning signs:** PoolDepleted test showing Settled in the emitted event.

### Pitfall 6: Calling recordRefundPaid with actualRefund=0 on PoolDepleted

**What goes wrong:** The PoolDepleted branch sets `actualRefund = 0` but forgets the WP-04 guard `if (actualRefund > 0)` before `recordRefundPaid`.
**Why it happens:** The new PoolDepleted branch sits inside the block that previously only had the else path.
**How to avoid:** The WP-04 guard at `PactSettler.sol:217` (`if (actualRefund > 0) { registry.recordRefundPaid(...) }`) already handles this correctly — as long as `actualRefund` remains 0 from the PoolDepleted branch, the hook is correctly skipped. Preserve the guard.

### Pitfall 7: ExposureCapClamped status on non-breach / zero-refund events

**What goes wrong:** Setting ExposureCapClamped when intendedRefund=0 (non-breach call).
**Why it happens:** Inference `payableRefund < intendedRefundAfterCap` evaluates `0 < 0` = false — correctly NOT clamped. But if `recordCallAndCapAccrual` is misimplemented and returns something other than 0, the inference could misfire.
**How to avoid:** The cap-clamp block in `settle_batch.rs` is guarded by `if intended_refund_after_cap > 0` (:400). The EVM equivalent in `recordCallAndCapAccrual` must preserve this guard: only enter the cap-clamp logic when `intendedRefund > 0`.
**Warning signs:** ExposureCapClamped status on a non-breach event.

---

## Adversarial Pass Recommendation (GATE A Report)

Per WP-04 OUTCOMES §e and STATE.md note: "WP-05 SHOULD enable a settlement threat-model / adversarial pass." Recommendation:

Enable a brief adversarial pass as part of WP-05. The scope is narrow — the four WP-05 seams only:
1. Can an attacker force `ExposureCapClamped` for another agent's endpoint by saturating the cap in the same batch?
2. Can a malicious settler call `settleBatch` with `events.length == 0` (empty batch) and bypass paused checks? (Solana: `event_count = 0` is valid — loop body never executes. EVM: same, pause check fires before loop.)
3. Is there a reentrancy vector through `registry.protocolPaused()` or the pool hooks in the PoolDepleted path? (PactPool is not untrusted; pool.payout is the only external call on the refund path and it only fires in the else branch — not on PoolDepleted.)

Recommendation: brief manual review (not a full fuzz suite — that is WP-06). Include a comment in the GATE A report. No Nyquist gates needed.

---

## Standard Stack

| Component | Version/Detail | Source |
|-----------|---------------|--------|
| Solidity | 0.8.30 | [VERIFIED: foundry.toml] |
| Foundry/Forge | 1.3.2 (per handoff §e) | [CITED: handoff doc] |
| OpenZeppelin | lib/openzeppelin-contracts (remapped) | [VERIFIED: foundry.toml remappings] |
| OZ AccessControl | IAccessControl.AccessControlUnauthorizedAccount | [VERIFIED: PactSettler.t.sol:5] |
| forge-std | lib/forge-std/src/ | [VERIFIED: foundry.toml] |
| EVM version | prague | [VERIFIED: foundry.toml] |

**No new dependencies needed for WP-05.** All custom errors, enums, interfaces, and contracts are already in place.

---

## Environment Availability

| Dependency | Required By | Available | Notes |
|------------|-------------|-----------|-------|
| forge | All EVM tests | Yes | Build clean, 90/90 green — confirmed during research |
| Solidity 0.8.30 | Compilation | Yes | foundry.toml pins it |
| OZ AccessControl | AccessControl pattern | Yes | Already in lib/ |
| PactRegistry.protocolPaused() | SET-11 | Yes | Confirmed at PactRegistry.sol:36 + IPactRegistry.sol:69 |
| EndpointConfig.paused | SET-11 per-event | Yes | Confirmed at IPactRegistry.sol:25 (bool paused) |
| ArcConfig.MAX_BATCH_SIZE | SET-12 | Yes | Confirmed = 50 at ArcConfig.sol:25 |
| ProtocolPaused/EndpointPaused/BatchTooLarge/PoolDepleted errors | All seams | Yes | Confirmed in PactErrors.sol |
| SettlementStatus.PoolDepleted/ExposureCapClamped | SET-09/10 | Yes | Confirmed in IPactSettler.sol:28-33 |

No missing dependencies. No blocking items.

---

## Validation Architecture

Nyquist/security gates are explicitly OFF (config.json). Validation contract is strict TDD with the ported LiteSVM oracle. Per-task commit cadence:

- **Per task RED:** `forge test --match-test <new_test_name> -vvv` (confirms RED)
- **Per task GREEN:** `forge test` (confirms new test GREEN + full 90/90 regression holds)
- **Phase gate (GATE B):** `forge build && forge test` — all tests green; gsd-verifier pass

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `vm.warp` is sufficient to advance `block.timestamp` for the period-reset test end-to-end through `settleBatch` (not just the unit hook test) | Test Port Plan, 07:81 | If `block.timestamp` is not used by forge in the same way, the period-reset condition may not fire; mitigated by WP-04 already having a passing `test_EndpointStats_PeriodReset` using `vm.warp` through the hook directly | [ASSUMED — but high confidence given WP-04 precedent] |
| A2 | The `uint64` ternary for saturating subtraction (`A > B ? A - B : 0`) is gas-equivalent to a Solidity `SafeMath` approach and matches Solana `saturating_sub` semantics exactly | Seam Mechanics, Seam 1 | Incorrect result at boundary; mitigated by test coverage of the 0-cap-remaining case |

**All other claims are VERIFIED by direct source read or VERIFIED by live forge run.**

---

## Open Questions

1. **P1 — ExposureCapClamped inference mechanism**
   - What we know: The seam forces inference by return-value comparison; the math is provably equivalent; no-rollback is correct.
   - What's unclear: Captain ratification of the mechanism + that no-rollback is the intended EVM behavior.
   - Recommendation: Include the P1 framing from this document in the GATE A report verbatim; wait for captain ruling before implementing seam 1.

2. **P3 — OPTIMIZED-DIVERGENCE for unauthorized+paused corner**
   - What we know: Only affects an unauthorized caller who would be rejected anyway; authorized+paused is identical on both chains.
   - What's unclear: Captain acceptance of the parity matrix entry.
   - Recommendation: Include the P3 framing in the GATE A report; document in WP-06 parity matrix regardless of ruling.

3. **BatchTooLarge boundary: `events.length` type**
   - What we know: `events.length` is `uint256`, `ArcConfig.MAX_BATCH_SIZE` is `uint16 = 50`. The comparison `events.length > ArcConfig.MAX_BATCH_SIZE` promotes `uint16` to `uint256` — comparison is correct.
   - What's unclear: Nothing — this is standard Solidity type promotion. Documented for clarity only.

---

## Sources

### Primary (HIGH confidence — direct source read)
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs` — full re-derivation of all control-flow anchors
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/pause_protocol.rs` — flag setter verified (state.paused = data[0])
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/pause_endpoint.rs` — flag setter verified
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/state.rs` — SettlementStatus enum, EndpointConfig, ProtocolConfig layouts
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/constants.rs` — MAX_BATCH_SIZE=50, MIN_PREMIUM_LAMPORTS=100
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/error.rs` — 33 variants (6000-6032)
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/tests/05-settle-batch.test.ts` lines 442-672 — 4 deferred tests
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/tests/06-pause.test.ts` — full
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/tests/07-exposure-cap.test.ts` — full
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/tests/09-auth-pda.test.ts` — full
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/tests/10-pause-protocol.test.ts` — full
- `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` — full WP-04 state confirmed
- `packages/program-evm/protocol-evm-v1/src/PactRegistry.sol` — full WP-04 state confirmed, seam comments at :265-271 confirmed
- `packages/program-evm/protocol-evm-v1/src/interfaces/IPactSettler.sol` — SettlementStatus enum confirmed (PoolDepleted=2, ExposureCapClamped=3)
- `packages/program-evm/protocol-evm-v1/src/interfaces/IPactRegistry.sol` — protocolPaused() getter confirmed
- `packages/program-evm/protocol-evm-v1/src/errors/PactErrors.sol` — all WP-05 error names confirmed present
- `packages/program-evm/protocol-evm-v1/src/ArcConfig.sol` — MAX_BATCH_SIZE=50 confirmed
- `packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol` — full WP-04 harness confirmed
- `packages/program-evm/protocol-evm-v1/test/PactRegistry.t.sol` — full 426 lines; WP-02 pause coverage deduped
- `packages/program-evm/protocol-evm-v1/foundry.toml` — build config confirmed
- `forge test` live run — 90/90 green confirmed

### Metadata

**Confidence breakdown:**
- Control-flow re-derivation: HIGH — read directly from Rust source
- Seam mechanics: HIGH — confirmed against WP-04 EVM code
- Test port plan: HIGH — derived from Solana test source + WP-04 patterns
- WP-02 dedup coverage: HIGH — full PactRegistry.t.sol read
- P1/P3 framing: HIGH (framing) / OPEN (resolution — captain only)

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (stable domain — Solidity + Foundry)
