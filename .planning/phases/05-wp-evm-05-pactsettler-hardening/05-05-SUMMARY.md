---
phase: 05-wp-evm-05-pactsettler-hardening
plan: 05
subsystem: program-evm/protocol-evm-v1
tags: [solidity, settlement, pool-depleted, evm-parity, tdd]
dependency_graph:
  requires: ["05-04"]
  provides: ["SET-09", "seam-2-pool-depleted"]
  affects:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
tech_stack:
  added: []
  patterns:
    - "PoolDepleted status overwrites ExposureCapClamped (D-LOCK-CLAMP-ORDER final-status precedence)"
    - "actualRefund=0 explicit for parity legibility even though already initialized 0"
    - "pool net balance = seed + creditPremium - debitForFees must be checked against payableRefund for strict-< test design"
key_files:
  created: []
  modified:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
decisions:
  - "SET-09 PoolDepleted clamp: status=PoolDepleted; actualRefund=0 in the previously-empty if block; no currentPeriodRefunds rollback; recordRefundPaid guard at if(actualRefund>0) correctly skips"
  - "Pool seed for combined cap+pool test must account for premium net: pool net = seed + premium - fee; for the strict-< condition to fire on a clamped payableRefund, seed must satisfy seed + (premium - fee) < payableRefund_clamped"
  - "D-LOCK-CLAMP-ORDER confirmed: status=PoolDepleted at line 232 is AFTER the ExposureCapClamped inference (line 192-194), so overwrite is structural, not conditional"
metrics:
  duration: "~15 minutes"
  completed: "2026-05-18"
  tasks: 2
  files: 2
requirements: [SET-09]
---

# Phase 05 Plan 05: PoolDepleted Clamp (Seam 2) Summary

**One-liner:** PoolDepleted clamp fills the empty `if (ps.currentBalance < payableRefund)` seam — `status=PoolDepleted; actualRefund=0` — porting `settle_batch.rs:462-469` with D-LOCK-CLAMP-ORDER final-status precedence proven by combined cap+pool test.

## What Was Built

Seam 2 of WP-EVM-05: the pool-depleted clamp in `PactSettler._settleSuccess`. The empty `if (ps.currentBalance < payableRefund) {}` block (left clean by WP-04) was filled with:

```solidity
status = SettlementStatus.PoolDepleted;
actualRefund = 0; // mirrors settle_batch.rs:469 (explicit for parity legibility)
```

This executes AFTER the 05-04 `ExposureCapClamped` inference (line 192), so when both fire (cap clamps the amount AND the pool cannot cover the clamped amount), `PoolDepleted` naturally overwrites `ExposureCapClamped` — D-LOCK-CLAMP-ORDER final-status precedence: `PoolDepleted > ExposureCapClamped > Settled`.

The WP-04 `else` branch (`pool.payout + pool.debitForRefund + actualRefund=payableRefund`) is byte-identical — not touched. The WP-04 `recordRefundPaid` guard (`if (actualRefund > 0)`) already correctly skips on the PoolDepleted path since `actualRefund` stays 0.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | PoolDepleted refund-skipped + combined cap+pool precedence tests | 5954ba3 | test/PactSettler.t.sol |
| 2 (GREEN) | Fill empty if with PoolDepleted + fix combined-test pool seed | 5339316 | src/PactSettler.sol, test/PactSettler.t.sol |

## Tests Added (2 new, both GREEN)

**`test_PoolDepleted_RefundSkippedAndMarked`** (port of 05-settle-batch.test.ts:442):
- Pool seeded 100, premium=1000, refund=200_000, cap=5_000_000 (no cap clamp fires)
- After creditPremium(1000) - debitForFees(100): pool net = 1000 < payableRefund (200_000)
- Expected: PoolDepleted (enum 2), actualRefund=0, agent balance = 10_000_000 - 1_000 (premium charged, no refund)

**`test_PoolDepleted_OverwritesExposureCapClamped`** (D-LOCK-CLAMP-ORDER precedence + P1(b) no-rollback):
- cap=1000, pool NOT seeded (default 0), refund=5000
- cap clamps to 1000 → ExposureCapClamped inferred by 05-04 (payableRefund=1000 < ev.refund=5000)
- pool net after credit/debit = 0 + 1000 - 100 = 900 < clamped 1000 → PoolDepleted overwrites
- Asserts: final status PoolDepleted (enum 2); currentPeriodRefunds=1000 (clamped amount, NOT rolled back); totalRefunds=0 (recordRefundPaid skipped); agent pays premium only

## Verification Results

```
forge build: Compiler run successful (notes only — pre-existing lint warnings, not errors)
forge test:  102 tests passed, 0 failed (100 prior + 2 new 05-05)
test_DuplicateCallIdPrecedesRecipientCoverageMismatch: PASS (regression pin)
test_PoolDepleted_RefundSkippedAndMarked:              PASS
test_PoolDepleted_OverwritesExposureCapClamped:        PASS
test_ExposureCapClamped_PartialActualRefund:           PASS (05-04, unaffected)
test_ExposureCap_CumulativeClampAcrossBatches:         PASS (05-04, unaffected)
```

Additive-only acceptance criteria:
- `grep -n "status = SettlementStatus.PoolDepleted;"` → line 232, inside the `if` block before `} else {`
- `git diff | grep -E "pool\.(payout|debitForRefund)\(ev"` → empty (else branch byte-identical)
- `git diff | grep "currentPeriodRefunds"` → comment line only (no code rollback)
- `grep -c "function test_PoolDepleted"` → 2

## Deviations from Plan

**1. [Rule 3 - Blocking] Pool seed adjustment for combined cap+pool test**

- **Found during:** Task 2 GREEN confirmation
- **Issue:** Plan specified `_fundPool(SLUG_B, 100)`. After `creditPremium(1000) - debitForFees(100)`, pool `currentBalance = 100 + 1000 - 100 = 1000`. Condition `ps.currentBalance < payableRefund` is strict (`<`), and `1000 < 1000` is FALSE. The else branch fired, paying 1000 — the opposite of what the test intends.
- **Fix:** Removed `_fundPool(SLUG_B, 100)` entirely. Pool starts at 0. After premium net: `0 + 1000 - 100 = 900 < 1000` — PoolDepleted fires correctly. The no-rollback and totalRefunds=0 assertions are unaffected.
- **Parity impact:** None. The parity authority (`settle_batch.rs:462-469`) checks `pool_balance < intended_refund_after_cap` — the EVM strict-`<` is a direct port. The test data just needed to satisfy this strict inequality correctly accounting for the premium net credit.
- **Files modified:** test/PactSettler.t.sol (same file as Task 1)
- **Commit:** 5339316 (folded into the GREEN commit)

## Known Stubs

None. The seam is fully implemented; no placeholders remain in the affected files.

## Threat Flags

None. This plan fills an existing internal branch condition — no new network endpoints, auth paths, file access patterns, or schema changes introduced.

## Self-Check

### Files exist

```
[ -f "packages/program-evm/protocol-evm-v1/src/PactSettler.sol" ] → FOUND
[ -f "packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol" ] → FOUND
```

### Commits exist

```
git log --oneline | grep 5954ba3 → FOUND: test(05-05): RED
git log --oneline | grep 5339316 → FOUND: feat(05-05): GREEN
```

### forge test result

```
102 tests passed, 0 failed — CONFIRMED GREEN
```

## Self-Check: PASSED

All files present. Both commits exist. forge suite 102/102 green. Additive-only criteria satisfied. No regressions. D-LOCK-CLAMP-ORDER proven by combined test. P1(b) no-rollback asserted. test_DuplicateCallIdPrecedesRecipientCoverageMismatch still PASS.
