---
phase: 04-pactsettler-happy-path
plan: 04
subsystem: protocol-evm-v1
tags: [evm, settler, economic-loop, fee-fanout, breach-refund, ep-stats, tdd, parity, gate-b]
dependency_graph:
  requires: [04-03]
  provides: [settleBatch-economic-loop, 9-ported-happy-path-tests, gate-b-report]
  affects: [WP-05, WP-06]
tech_stack:
  added: []
  patterns: [settleBatch-private-helper-stack-split, two-ep-mutation-points, WP-05-additive-seams]
key_files:
  created:
    - .planning/phases/04-pactsettler-happy-path/04-REPORT-gateB.md
  modified:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
decisions:
  - "Provisional emit seam (04-03) replaced with full economic loop in _settleSuccess private helper (stack-too-deep fix: settleBatch has too many locals in one frame)"
  - "Mutation ORDER mirrors settle_batch.rs exactly: creditPremium -> recordCallAndCapAccrual (ep1, pre-fan-out) -> fee fan-out -> refund transfer -> recordRefundPaid (ep2, post-transfer)"
  - "PoolDepleted seam: EMPTY if(ps.currentBalance < payableRefund) block in _settleSuccess — WP-05 inserts status assignment additively, zero WP-04 rewrite"
  - "vm.warp(1_000_000) added to test_MixedBatch3Endpoints: Foundry default block.timestamp=1 causes tsOffset=3 underflow in _makeEvent; test-mechanics fix (not parity deviation)"
  - "test_CallSettled_ABI_Identity asserts IPactSettler.CallSettled and PactEvents.CallSettled share topic0 — keccak256('CallSettled(bytes16,bytes16,address,uint64,uint64,uint64,uint8,bool,uint32,uint64)') — alias literally true (GATE-A E3 condition)"
metrics:
  duration: "~45 minutes"
  completed: "2026-05-18"
  tasks_completed: 2
  tasks_total: 3
  files_created: 2
  files_modified: 2
  tests_added: 6
  tests_total: 89
  tests_regression: 83
---

# Phase 4 Plan 04: WP-EVM-04 Economic Loop + 9 Ported Tests Summary

settleBatch full economic loop per settle_batch.rs:357-522 with the TWO GATE-A E1 split
hooks at exact source mutation positions (recordCallAndCapAccrual BEFORE fee fan-out,
recordRefundPaid AFTER refund transfer); 9 ported 05-settle-batch.test.ts happy-path tests
green with verbatim numeric assertions; GATE B report written; execution stopped.

## What Was Built

### Task 1: settleBatch economic loop (SET-05/06/07/08)

Replaced the plan-03 provisional emit seam in `PactSettler.sol` with the complete
per-event economic body extracted into `_settleSuccess` private helper (stack-too-deep
fix — settleBatch accumulates too many locals in one frame with all guards + economic ops).

**Mutation order mirrors settle_batch.rs EXACTLY:**

| Step | EVM call | Rust lines | Operation |
|------|----------|------------|-----------|
| 6 | `pool.creditPremium(ev.endpointSlug, ev.premium)` | :357-369 | Pool gross credit |
| 7 | `uint64 intendedRefundAfterCap = ev.refund` | :380 | Seed WP-05-ready refund local |
| 7c | `payableRefund = registry.recordCallAndCapAccrual(slug, premium, breach, intendedRefundAfterCap)` | :385-414 | ep mutation point 1 BEFORE fee fan-out |
| 8 | fee loop + `pool.debitForFees` | :418-453 | Fee fan-out floor-div, zero-skip, residual |
| 9 | `pool.payout(agent) + pool.debitForRefund` (in else) | :455-502 | Refund transfer (WP-05 PoolDepleted EMPTY if seam) |
| 9c | `registry.recordRefundPaid(slug, actualRefund)` if >0 | :493-499 | ep mutation point 2 AFTER transfer |
| 10 | `emit CallSettled(...)` | :504-522 | One IPactSettler.CallSettled per call |

**Key implementation details:**
- `uint64(uint256(ev.premium) * ep.feeRecipients[j].bps / 10_000)` — uint256 intermediate, floor truncation
- Iterates `ep.feeRecipientCount` (NOT `ev.feeRecipientCountHint` — pitfall 6)
- `_ckAdd(totalFeePaid, feeAmount)` — overflow-checked accumulator
- `if (totalFeePaid > 0) pool.debitForFees(...)` — guards zero-fee debit
- PoolDepleted seam: EMPTY `if (ps.currentBalance < payableRefund) {}` block — WP-05 inserts status assignment here additively; the refund transfer is in the `else`
- `if (actualRefund > 0) registry.recordRefundPaid(...)` — mirrors Solana only reaching :493-499 in the paid branch

### Task 2: Remaining 5 happy-path tests (tests 2,3,4,9 + ABI-identity)

Added to `test/PactSettler.t.sol` (numbers VERBATIM from 05-settle-batch.test.ts oracle):

| Test | Key assertions |
|------|----------------|
| test_SingleEventExplicit85_10_5Split | treasury=10_000, aff=5_000, pool=5_085_000, agent=9_900_000 |
| test_BreachRefundsAgentFromPool | agent=10_049_000, pool=4_950_900, treasury=100; currentPeriodRefunds=50_000; totalRefunds=50_000 |
| test_MixedBatch3Endpoints | agent=29_400_000, ep1=1_090_000, ep2=1_180_000, ep3=1_299_970, treasury=20_030, aff2=10_000 |
| test_HappyPathSettledStatusEvent | CallSettled(Settled(0), refund=50_000, actualRefund=50_000) |
| test_CallSettled_ABI_Identity | IPactSettler.CallSettled topic0 == PactEvents.CallSettled topic0 (GATE-A E3) |

Also added `IPactPool` and `PactEvents` imports to test file.

## RED Evidence (TDD — recorded before GREEN per D-LOCK-2)

### Task 1 RED (confirmed before any src change)

```
[FAIL: pool usdc: 5010000 != 5009000] test_SingleEventDefaultTreasuryFanOut()
```

Provisional seam credits full premium via `transferFrom` but does no fee fan-out: pool
retains 10_000 instead of net 9_000. Expected 5_009_000 (pool + credit - treasury fee)
but got 5_010_000 (pool + credit, no fee deducted). Confirms economic half was absent.

### Task 2 RED (confirmed before GREEN)

On first run of all 5 new tests against the Task 1 implementation:

```
[FAIL: panic: arithmetic underflow or overflow (0x11)] test_MixedBatch3Endpoints()
```

All other 4 new tests passed immediately (implementation was correct). The mixed-3 failure
was a test-mechanics issue: `_makeEvent` with `tsOffset=3` and Foundry's default
`block.timestamp=1` causes `uint64(1) - 3` underflow panic before `settleBatch` is
even called. Fix: `vm.warp(1_000_000)` before event construction. This is the same
category of test-mechanics fix as 04-03's `vm.prank/expectRevert` ordering (pitfall 3
variant) — not a parity/src defect.

The 4 tests that passed immediately confirm the Task 1 economic loop was already
bit-identical to the oracle for those scenarios. Only test_MixedBatch3Endpoints needed
the warp fix (timestamp underflow, not economic error).

## GATE-A Rulings Honored

| Ruling | Implementation |
|--------|---------------|
| E1 OPTION (a) | TWO SETTLER_ROLE-gated hooks on PactRegistry composed at exact settle_batch.rs mutation positions |
| D-SPLIT refined | Period reset (settle_batch.rs:396-399) in recordCallAndCapAccrual (PactRegistry); NOT inline in PactSettler |
| E2 | OZ AccessControl SETTLER_ROLE on PactSettler (04-02); settleBatch onlyRole(SETTLER_ROLE) |
| E3 | Single IPactSettler.CallSettled per call; no second PactEvents emission; ABI-identity asserted |
| E4 | Dedup sentinel before premium-in (04-03); cr[2]/readU64 ports to vm.expectEmit; event-as-truth |

## WP-05 Seams Left Clean

1. **ExposureCapClamped** (inside `recordCallAndCapAccrual`): seam comment between period reset and currentPeriodRefunds accrual. WP-05 inserts the saturating-sub + clamp here; `payableRefund` return drives the refund transfer. Zero WP-04 rewrite.

2. **PoolDepleted** (in `_settleSuccess`): EMPTY `if (ps.currentBalance < payableRefund) { }` block. WP-05 sets status=PoolDepleted and actualRefund=0 here. Zero WP-04 rewrite.

3. **Pause kill-switches**: entirely WP-05; pre-loop + per-event. Not touched.

## N-A-ON-EVM List (for WP-06 parity matrix)

| N-A Item | Reason |
|----------|--------|
| `deriveCallRecord` PDA | No PDAs on EVM; dedup via `mapping(bytes16=>bool)` |
| `getAccountData` CallRecord existence | Event-as-truth (GATE-A E4); `_settledCallIds` mapping |
| `cr[2]` / `readU64(cr,80)` / `readU64(cr,88)` byte reads | Ported to `vm.expectEmit` on CallSettled.{status,refund,actualRefund} |
| `is_data_empty()` dedup check | `_settledCallIds[callId]` mapping check |
| SPL Token delegate pre-flight | ERC-20 allowance checked implicitly by `transferFrom` |
| `SettlementAuthority` PDA signer | `onlyRole(SETTLER_ROLE)` AccessControl |
| `pool_vault` ATA binding | Single `PactPool` contract holds all USDC |
| `NotEnoughAccountKeys` / `InvalidSeeds` | No accounts/PDAs on EVM |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Stack-too-deep in settleBatch**
- **Found during:** Task 1 GREEN
- **Issue:** `settleBatch` accumulates too many local variables (guards + ep snapshot + dedup + premium-in locals + economic body locals = exceeds EVM 16-slot stack limit)
- **Fix:** Extract economic success body into `_settleSuccess(SettlementEvent calldata, EndpointConfig memory)` private helper. Parity is preserved exactly — only the call-frame boundary changed.
- **Files modified:** `src/PactSettler.sol`
- **Impact:** Zero parity change. Mutation order, seam positions, and all observable behavior identical.

**2. [Rule 1 - Test mechanics] test_MixedBatch3Endpoints tsOffset underflow**
- **Found during:** Task 2 RED
- **Issue:** Foundry default `block.timestamp=1`; `_makeEvent` with `tsOffset=3` computes `uint64(1)-3` which underflows before settleBatch is called
- **Fix:** `vm.warp(1_000_000)` before event construction in that test
- **Files modified:** `test/PactSettler.t.sol`
- **Parity impact:** None — timestamp values in `SettlementEvent` only need to satisfy `<= block.timestamp` for the guard. Balance assertions are unaffected.

## GATE B Status

**STOPPED.** GATE B reached:
- `forge build`: clean, exit 0
- `forge test`: 89 passed, 0 failed
- `04-REPORT-gateB.md` written to `.planning/phases/04-pactsettler-happy-path/04-REPORT-gateB.md`
- Cockpit notice sent: `cockpit runtime send pact-network`
- No `git push` performed
- No PR #204 comment posted
- Awaiting captain approval before any push/PR activity

## Known Stubs

None. All economic logic fully implemented per the GATE-A rulings and settle_batch.rs:357-522.
WP-05 seams are intentional clean insertion points, not stubs — they are documented
additive seams where WP-05 layers in without rewriting WP-04.

## Threat Flags

No new network endpoints, auth paths, or trust-boundary schema changes beyond what
was already sanctioned by GATE-A. The economic loop composes existing SETTLER_ROLE-gated
hooks. WP-05 threat-model/adversarial pass covers the settlement path.

## Self-Check

Files created/modified exist:
- `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` — FOUND
- `packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol` — FOUND
- `.planning/phases/04-pactsettler-happy-path/04-REPORT-gateB.md` — FOUND

Commits exist:
- `f46a0b6` — test RED: default-10% fan-out economic assertions
- `8cc7b1a` — feat GREEN: settleBatch full economic loop
- `8592faf` — test: remaining 05 happy-path scenarios; 9/9 green

## Self-Check: PASSED
