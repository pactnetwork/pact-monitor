---
phase: 04-pactsettler-happy-path
plan: 03
subsystem: protocol-evm-v1
tags: [evm, settler, dedup, premium-in, delegate-failed, tdd, parity]
dependency_graph:
  requires: [04-02]
  provides: [settleBatch-guards, settleBatch-dedup, settleBatch-premium-in-DelegateFailed]
  affects: [04-04]
tech_stack:
  added: []
  patterns: [dedup-mapping-before-premium-in, raw-IERC20-try-catch, provisional-emit-seam]
key_files:
  created: []
  modified:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
decisions:
  - "Dedup sentinel (_settledCallIds[callId]=true) set BEFORE premium-in try/catch per GATE-A E4 ruling (settle_batch.rs:243-262 confirmed source)"
  - "Raw IERC20.transferFrom in try/catch (NOT SafeERC20) — both false return and revert caught as DelegateFailed (pitfall 1)"
  - "Provisional CallSettled(Settled, actualRefund=0) emit on success path; plan 04-04 MUST replace with full economic emit"
  - "Guard order matches settle_batch.rs:158-215 exactly: InvalidTimestamp -> PremiumTooSmall -> FeeRecipientArrayTooLong -> RecipientCoverageMismatch"
  - "No WP-05 guards added (EndpointPaused, BatchTooLarge) — grep-verified"
metrics:
  duration: "~25 minutes"
  completed: "2026-05-18"
  tasks_completed: 2
  tasks_total: 2
  files_created: 0
  files_modified: 2
  tests_added: 6
  tests_total: 83
  tests_regression: 77
---

# Phase 4 Plan 03: WP-EVM-04 Per-Event Guards + Dedup + Premium-In Summary

Per-event prologue of settleBatch ported from settle_batch.rs: settler-role gate
(SET-01 via 04-02 AccessControl), three hard-revert guards (SET-03), dedup
mapping set before premium-in (SET-04, GATE-A E4), raw IERC20 try/catch to
DelegateFailed-and-continue (SET-02, GATE-A E3). 6 new tests, all 83 green.

## What Was Built

### Task 1: Per-event guards + settler gate (SET-01/03)

Implemented the for-loop body in `settleBatch` with guards in exact
settle_batch.rs:158-215 order:

1. `if (ev.timestamp > uint64(block.timestamp)) revert InvalidTimestamp();`
   — settle_batch.rs:158-160
2. `if (ev.premium < ArcConfig.MIN_PREMIUM) revert PremiumTooSmall();`
   — settle_batch.rs:161-163
3. `if (ev.feeRecipientCountHint > ArcConfig.MAX_FEE_RECIPIENTS) revert FeeRecipientArrayTooLong();`
   — settle_batch.rs:164-166
4. `IPactRegistry.getEndpoint(ev.endpointSlug)` → endpoint snapshot
   — settle_batch.rs:200-221
5. `if (ep.feeRecipientCount != ev.feeRecipientCountHint) revert RecipientCoverageMismatch();`
   — settle_batch.rs:212-215

`onlyRole(SETTLER_ROLE)` (already on the function from 04-02) satisfies SET-01
with no additional code. Endpoint-paused check (settle_batch.rs:209-211) and
BatchTooLarge guard are WP-05 — not added.

New tests: `test_UnauthorizedSettlerRejected`, `test_MinPremiumEdgeRejected`,
`test_InvalidTimestampRejected`, `test_RecipientCoverageMismatchRejected`.

**Commits:**
- `525e6a1` — test RED: 4 guard/auth tests
- `ce1c281` — feat GREEN: per-event guards + settler gate

### Task 2: Dedup mapping + premium-in try/catch → DelegateFailed (SET-02/04)

Implemented per GATE-A E4 and E3 rulings:

1. `mapping(bytes16 => bool) private _settledCallIds;` — EVM analogue of
   Solana CallRecord PDA existence check (settle_batch.rs:194-196)
2. Dedup check: `if (_settledCallIds[ev.callId]) revert DuplicateCallId();`
   — hard revert, whole batch aborts
3. Sentinel set BEFORE premium-in: `_settledCallIds[ev.callId] = true;`
   — per GATE-A E4 ruling (settle_batch.rs:243-262 allocates CallRecord PDA
   before the delegate pre-flight, so DelegateFailed also dedups)
4. Premium-in: `try IERC20(usdc).transferFrom(ev.agent, address(pool), ev.premium) returns (bool ok) { premiumInOk = ok; } catch { premiumInOk = false; }`
   — raw IERC20, NOT SafeERC20 (pitfall 1)
5. On `!premiumInOk`: `status = DelegateFailed`, emit `IPactSettler.CallSettled`
   (typed-enum, no second PactEvents emission — GATE-A E3), `continue`

New tests: `test_DuplicateCallIdRejected`, `test_RevokeMarksDelegateFailedAndContinues`.

**Commits:**
- `3abe9c0` — test RED: 2 dedup/DelegateFailed tests
- `9602147` — feat GREEN: dedup mapping + premium-in try/catch

## RED Evidence (TDD — recorded before GREEN per D-LOCK-2)

### Task 1 RED (confirmed before any src change)

```
Ran 4 tests for test/PactSettler.t.sol:PactSettlerTest
[FAIL: Error != expected error: NOT_IMPLEMENTED != custom error 0xb7d09497] test_InvalidTimestampRejected()
[FAIL: Error != expected error: NOT_IMPLEMENTED != custom error 0xe9a56c20] test_MinPremiumEdgeRejected()
[FAIL: Error != expected error: NOT_IMPLEMENTED != custom error 0xf8276d68] test_RecipientCoverageMismatchRejected()
[PASS] test_UnauthorizedSettlerRejected()   ← AccessControl already works from 04-02
```

3 guard tests fail: settleBatch still reverts NOT_IMPLEMENTED string instead of
the expected custom error selectors. Unauthorized test already passes because
`onlyRole(SETTLER_ROLE)` was added in plan 04-02 — confirmed RED for the 3
guard tests; SET-01 was already implemented.

Note: vm.prank/expectRevert order fix applied in RED commit (expectRevert must
precede vm.prank, not be interleaved with it — pitfall 3 variant).

### Task 2 RED (confirmed before any src change)

```
Ran 2 tests for test/PactSettler.t.sol:PactSettlerTest
[FAIL: next call did not revert as expected] test_DuplicateCallIdRejected()
[FAIL: log != expected log] test_RevokeMarksDelegateFailedAndContinues()
```

- `test_DuplicateCallIdRejected`: second settle did not revert — no dedup mapping yet
- `test_RevokeMarksDelegateFailedAndContinues`: no CallSettled event emitted — no premium-in path yet

## settleBatch Prologue Order vs settle_batch.rs Line Refs

| EVM line | Rust line | Operation |
|----------|-----------|-----------|
| 65 | 158-160 | `if (ev.timestamp > uint64(block.timestamp)) revert InvalidTimestamp()` |
| 66 | 161-163 | `if (ev.premium < ArcConfig.MIN_PREMIUM) revert PremiumTooSmall()` |
| 67-68 | 164-166 | `if (ev.feeRecipientCountHint > ArcConfig.MAX_FEE_RECIPIENTS) revert FeeRecipientArrayTooLong()` |
| 72-73 | 200-221 | `IPactRegistry.getEndpoint(ev.endpointSlug)` snapshot |
| 74-75 | 212-215 | `if (ep.feeRecipientCount != ev.feeRecipientCountHint) revert RecipientCoverageMismatch()` |
| 85-86 | 194-196 | dedup check: `if (_settledCallIds[ev.callId]) revert DuplicateCallId()` |
| 92 | 243-262 | sentinel set: `_settledCallIds[ev.callId] = true` (BEFORE premium-in) |
| 101-103 | 295-355 | `try IERC20(usdc).transferFrom(ev.agent, address(pool), ev.premium)` |

Note: In settle_batch.rs, the dedup check is at line 194 (before the endpoint
snapshot at 200); in the EVM implementation the dedup check follows the endpoint
snapshot (after the fee-count mismatch check) because the endpoint snapshot is
needed to validate the hint. The dedup mapping set (line 92) is still before
the premium-in try/catch (line 101) — which is the parity-critical invariant
per GATE-A E4.

## GATE-A Rulings Honored

**E3 (CallSettled event consolidation):** Emit ONLY `IPactSettler.CallSettled`
(typed enum). No second `PactEvents` emission. Exactly one `CallSettled` per
call including DelegateFailed. Verified in `test_RevokeMarksDelegateFailedAndContinues`
via `vm.expectEmit`.

**E4 (dedup-before-premium-in):** `_settledCallIds[ev.callId] = true` at line
92, `try IERC20(...).transferFrom(...)` at line 101. Line 92 < line 101 — grep
verified. DelegateFailed events consume the callId and are not retryable —
verified by the third assertion in `test_RevokeMarksDelegateFailedAndContinues`
(retry of fill(21) reverts DuplicateCallId after DelegateFailed).

## Provisional Emit Seam — Plan 04-04 MUST Replace

On the premium-in success path, a provisional `CallSettled(Settled, actualRefund=0)`
is emitted at the end of the loop. This is intentional scaffolding so that
`test_DuplicateCallIdRejected`'s first `settler.settleBatch` call does not
revert while the economic half (pool credit / endpoint stats / fee fan-out /
refund) is not yet implemented.

Plan 04-04 MUST replace this provisional emit with the full economic emit
(exactly one `IPactSettler.CallSettled` per call per GATE-A E3 ruling). The
provisional emit will be removed and replaced — not augmented.

Location: `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` — the
comment block `// PROVISIONAL SEAM (plan 04-03 → plan 04-04)` marks the exact
replacement point.

## Deviations from Plan

None — plan executed exactly as written. The vm.prank/expectRevert ordering
fix in the unauthorized test is a test-mechanics correction (not a parity
deviation): `vm.expectRevert(...)` must come before `vm.prank(fake)` so the
prank is not consumed by the `settler.SETTLER_ROLE()` call inside the selector
encoding. The cached `settlerRole` pattern from `setUp()` was already
established by plan 04-02 for this exact reason (pitfall 3).

## Known Stubs

One intentional provisional seam:
- File: `packages/program-evm/protocol-evm-v1/src/PactSettler.sol`
- Location: lines ~130-145 (the `// PROVISIONAL SEAM` comment block)
- Description: `emit CallSettled(..., actualRefund=0)` on the success path with
  no preceding economic operations (no creditPremium, no fee fan-out, no refund).
  Premium funds have moved (agent→pool via transferFrom) but pool accounting
  and endpoint stats are not yet updated.
- Resolution: plan 04-04 Task 1/2 replaces this with the full economic sequence
  and the real final emit.

## Threat Flags

No new network endpoints, auth paths, or trust-boundary schema changes beyond
what was already sanctioned by GATE-A. The `_settledCallIds` mapping is write-
gated by `onlyRole(SETTLER_ROLE)` (via `settleBatch`). WP-05 threat-model/
adversarial pass covers the settlement path.

## Self-Check

Files modified exist:
- `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` — FOUND
- `packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol` — FOUND

Commits exist:
- `525e6a1` — test RED Task 1
- `ce1c281` — feat GREEN Task 1
- `3abe9c0` — test RED Task 2
- `9602147` — feat GREEN Task 2

## Self-Check: PASSED
