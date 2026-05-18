---
phase: 05-wp-evm-05-pactsettler-hardening
plan: "04"
subsystem: program-evm
tags: [evm, settler, exposure-cap, tdd, parity-port, SET-10]
requirements: [SET-10]

dependency_graph:
  requires: ["05-03"]
  provides: ["exposure-cap-clamp-seam1", "P1-status-inference"]
  affects: ["PactRegistry.recordCallAndCapAccrual", "PactSettler._settleSuccess"]

tech_stack:
  added: []
  patterns:
    - "ternary saturatingSub for uint64 (parity-exact to Rust saturating_sub)"
    - "P1 inference: payableRefund < ev.refund => ExposureCapClamped"
    - "SettlementStatus local in _settleSuccess (set before pool-balance check)"

key_files:
  created: []
  modified:
    - packages/program-evm/protocol-evm-v1/src/PactRegistry.sol
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol

decisions:
  - "Inlined intendedRefundAfterCap as ev.refund to free one stack slot (stack-too-deep auto-fix Rule 3); semantics identical to settle_batch.rs:380 seed"
  - "P1 inference uses ev.refund directly: payableRefund < ev.refund is provably equivalent to the captain-ratified payableRefund < intendedRefundAfterCap"
  - "recordCallAndCapAccrual call-site arguments UNCHANGED (P1 seam pin)"

metrics:
  duration: "~25 minutes"
  completed: "2026-05-18"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
---

# Phase 05 Plan 04: Exposure-Cap Clamp (Seam 1) Summary

Additive port of `settle_batch.rs:400-408` cap clamp + captain-ratified P1 inference
mechanism into `PactRegistry.recordCallAndCapAccrual` and `PactSettler._settleSuccess`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Exposure-cap clamp + cumulative + 1-hour-reset tests | 7eecfdb | test/PactSettler.t.sol |
| 2 (GREEN) | Cap clamp in recordCallAndCapAccrual | 323699e | src/PactRegistry.sol |
| 2 (GREEN) | P1 inference + status local in _settleSuccess | 2157b75 | src/PactSettler.sol |

## What Was Built

**PactRegistry.sol** (seam 1 fill, `recordCallAndCapAccrual`): Between the WP-04 period
reset and the `currentPeriodRefunds` accrual, inserted the exposure-cap clamp ported from
`settle_batch.rs:400-408`:

```solidity
if (payableRefund > 0) {
    uint64 capRemaining = ep.exposureCapPerHour > ep.currentPeriodRefunds
        ? ep.exposureCapPerHour - ep.currentPeriodRefunds
        : 0;
    if (payableRefund > capRemaining) {
        payableRefund = capRemaining;
    }
}
```

Solana `saturating_sub` parity: ternary guard, never reverts/underflows. When
`currentPeriodRefunds >= exposureCap`, `cap_remaining = 0` and everything clamps to 0
(adversarial vector 1 from the GATE-A adversarial pass). The clamped `payableRefund` is
returned to the UNCHANGED `_settleSuccess` call site (P1 seam pin). The existing
`currentPeriodRefunds` accrual at `:274-275` uses the now-clamped value
(D-LOCK-CLAMP-ORDER; NOT rolled back on PoolDepleted).

**PactSettler.sol** (P1 captain-ratified inference, `_settleSuccess`): Introduced a
`SettlementStatus status` local set AFTER `recordCallAndCapAccrual` returns and BEFORE the
`pool.balanceOf` pool-balance check (D-LOCK-CLAMP-ORDER, mirrors Solana `:407-then-:468`):

```solidity
SettlementStatus status = SettlementStatus.Settled;
if (payableRefund < ev.refund) {
    status = SettlementStatus.ExposureCapClamped;
}
```

The emit now passes `status` instead of the hardcoded `SettlementStatus.Settled`, so
`ExposureCapClamped` propagates. The `PoolDepleted` assignment (plan 05-05 seam 2) will
overwrite `status` in the empty `if` block — seam left clean for 05-05.

**PactSettler.t.sol** (3 new tests):
- `test_ExposureCapClamped_PartialActualRefund`: cap=1000, refund=5000 -> clamped to
  1000, ExposureCapClamped, agent net 0.
- `test_ExposureCap_CumulativeClampAcrossBatches`: two-batch cap exhaustion + adversarial
  vector 1 (saturatingSub boundary: currentPeriodRefunds >= exposureCap -> cap_remaining=0).
- `test_ExposureCap_ResetsAfter1Hour`: vm.warp asserts WP-04 period reset end-to-end
  through settleBatch; both refunds credited post-reset.

## Forge Results

```
Ran 6 test suites: 100 tests passed, 0 failed, 0 skipped (100 total)
  (97 prior + 3 new exposure-cap tests)
```

test_DuplicateCallIdPrecedesRecipientCoverageMismatch: PASS (locked regression guard).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Stack-too-deep from new `status` local in `_settleSuccess`**
- **Found during:** Task 2 GREEN — first compile after adding `SettlementStatus status`
- **Issue:** Adding the `status` local to `_settleSuccess` pushed the frame over the
  Solidity stack limit. Error at `src/PactSettler.sol:261` (the `ev.timestamp` emit arg).
  `_settleSuccess` already had many locals (params `ev`/`ep`, `payableRefund`,
  `intendedRefundAfterCap`, `totalFeePaid`, `feeAmount`, `actualRefund`, `ps`).
- **Fix:** Inlined `intendedRefundAfterCap` as `ev.refund` at the call site (saves one
  stack slot). Semantically identical: `settle_batch.rs:380` seeds
  `intended_refund_after_cap = refund_lamports` which equals `ev.refund`. The P1
  inference comparison becomes `payableRefund < ev.refund` (provably equivalent to
  `payableRefund < intendedRefundAfterCap` since `intendedRefundAfterCap == ev.refund`
  before any mutation). The `recordCallAndCapAccrual` call-site arguments are UNCHANGED
  (P1 seam pin: `ev.refund` is passed explicitly, same value as the removed local).
- **Files modified:** `src/PactSettler.sol`
- **Commit:** 2157b75
- **Parity impact:** None. The captain-ratified P1 predicate is preserved verbatim;
  only the intermediate local is eliminated.

## Known Stubs

The `PoolDepleted` empty `if` block at `PactSettler.sol:223-228` remains intentionally
empty — it is the clean seam for plan 05-05 (seam 2). This is not a stub that prevents
plan 05-04's goal; SET-10 (ExposureCapClamped) is fully implemented and tested.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes
introduced. The cap clamp and status inference are purely internal to the existing
`recordCallAndCapAccrual` / `_settleSuccess` call graph with unchanged external interfaces.

## Self-Check: PASSED

### Files exist
- FOUND: packages/program-evm/protocol-evm-v1/src/PactRegistry.sol
- FOUND: packages/program-evm/protocol-evm-v1/src/PactSettler.sol
- FOUND: packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol

### Commits exist
- FOUND: 7eecfdb (RED tests)
- FOUND: 323699e (PactRegistry cap clamp)
- FOUND: 2157b75 (PactSettler P1 inference)

### Test suite
- 100 tests passed, 0 failed, 0 skipped (100 total)
