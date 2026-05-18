---
phase: 05-wp-evm-05-pactsettler-hardening
plan: "06"
subsystem: program-evm/protocol-evm-v1
tags: [solidity, settlement, evm-parity, tdd, n-a-matrix, regression, gate-b]
dependency_graph:
  requires: ["05-05"]
  provides: ["SET-09", "SET-10", "SET-11", "SET-12", "05-NA-MATRIX", "WP-05-gate-b-regression"]
  affects:
    - .planning/phases/05-wp-evm-05-pactsettler-hardening/05-NA-MATRIX.md
tech_stack:
  added: []
  patterns:
    - "N-A-ON-EVM rationale table with named surviving WP-02 invariant tests"
    - "P3 OPTIMIZED-DIVERGENCE corner documented for WP-06 parity matrix"
    - "bounded adversarial-pass review (3 vectors, all clean, no new fuzz infrastructure)"
key_files:
  created:
    - .planning/phases/05-wp-evm-05-pactsettler-hardening/05-NA-MATRIX.md
  modified: []
decisions:
  - "All 15 PORT rows confirmed green via 05-02..05-05 + WP-02 — zero gaps, no new tests needed in 05-06"
  - "07:25 two-sub-case coverage confirmed by test_ExposureCap_CumulativeClampAcrossBatches (batch-1 Settled under-cap + batch-2 ExposureCapClamped over-cap + batch-3 saturatingSub=0)"
  - "N-A matrix adversarial-pass: 3 vectors all CLEAN — no new test infrastructure added per GATE-A ruling (brief bounded review only, not a fuzz suite)"
  - "D-LOCK-EXPCAP-NA confirmed: ExposureCapExceeded is unreachable from settle_batch.rs — cap always clamps to status, never reverts exceeded"
metrics:
  duration: "~20 minutes"
  completed: "2026-05-18"
  tasks: 2
  files: 1
requirements: [SET-09, SET-10, SET-11, SET-12]
---

# Phase 05 Plan 06: Port Completion + N-A Matrix + Full Regression Summary

**One-liner:** WP-05 test-port closure — all 15 PORT rows confirmed green with zero gaps; 05-NA-MATRIX.md records 7 N-A-ON-EVM rationales, P3 OPTIMIZED-DIVERGENCE corner, and 3-vector adversarial-pass review; full 102/102 regression green.

## What Was Built

**Task 1 — Port inventory + N-A matrix:**

Performed a full cross-check of every row in the 05-CONTEXT.md PORT/N-A disposition table against
existing tests in PactSettler.t.sol (05-02..05-05) and PactRegistry.t.sol (WP-02). All 15 PORT
rows are covered. No new Foundry tests were required — every PORT scenario was already green from
prior plans in the serial chain.

Coverage confirmed:

| Source | Covering test | Plan |
|---|---|---|
| 05:442 PoolDepleted | test_PoolDepleted_RefundSkippedAndMarked | 05-05 |
| 05:485 ExposureCapClamped | test_ExposureCapClamped_PartialActualRefund | 05-04 |
| 05:529 ProtocolPaused rejects | test_ProtocolPaused_RejectsSettleBatch | 05-02 |
| 05:595 resume after unpause | test_ProtocolPaused_ResumesAfterUnpause | 05-02 |
| 06:12/34 pause_endpoint set/unset | test_PauseEndpoint_SetsPaused / _CanUnpause | WP-02 |
| 06:55 pause_endpoint non-authority | test_PauseEndpoint_RejectsNonAuthority | WP-02 |
| 06 EndpointPaused per-event | test_EndpointPaused_RevertsPerEvent | 05-03 |
| 06 EndpointPaused resume | test_EndpointPaused_CanResumeAfterUnpause | 05-03 |
| 06 D-LOCK-PREC dedup before pause | test_EndpointPaused_DedupReadPrecedesEndpointPaused | 05-03 |
| 07:25 cumulative cap (both sub-cases) | test_ExposureCap_CumulativeClampAcrossBatches | 05-04 |
| 07:81 1-hour reset | test_ExposureCap_ResetsAfter1Hour | 05-05 |
| 10:28 pause_protocol toggle | test_PauseProtocol_SetAndClear | WP-02 |
| 10:72 pause_protocol non-authority | test_PauseProtocol_RejectsNonAuthority | WP-02 |
| BatchTooLarge 51-event | test_BatchTooLarge_51EventsRevert | 05-02 |
| BatchTooLarge 50-event boundary | test_BatchTooLarge_50EventsAccepted | 05-02 |

No WP-02 registry-side scenario (06:12/34/55, 10:28/72) is re-implemented in PactSettler.t.sol.

Created `.planning/phases/05-wp-evm-05-pactsettler-hardening/05-NA-MATRIX.md` containing:
- 7 N-A-ON-EVM rows (09:47, 09:78, 09:144, 09:172, 10:94, 10:128, D-LOCK-EXPCAP-NA) with one-line WP-06-matrix rationales and named surviving WP-02 invariant tests
- P3 OPTIMIZED-DIVERGENCE corner documentation (unauthorized+paused corner: EVM returns AccessControlUnauthorizedAccount vs Solana ProtocolPaused; authorized+paused is identical on both chains)
- Bounded adversarial-pass review (3 vectors per GATE-A ruling — not a fuzz suite):
  - Vector 1 (cross-agent cap saturation / saturatingSub=0 boundary): CLEAN — already tested by test_ExposureCap_CumulativeClampAcrossBatches third batch
  - Vector 2 (empty-batch pause-bypass): CLEAN — protocolPaused check fires pre-loop; events.length==0 cannot bypass it
  - Vector 3 (reentrancy via protocolPaused()/pool hooks on PoolDepleted path): CLEAN — no external calls on PoolDepleted branch; dedup SET before premium-in protects against reentry
- PORT coverage summary table confirming all 15 PORT rows green

WP-02 surviving-invariant tests confirmed live: all 4 (test_PauseEndpoint_RejectsNonAuthority, test_PauseProtocol_RejectsNonAuthority, test_UpdateEndpointConfig_RejectsNonAuthority, test_UpdateFeeRecipients_RejectsNonAuthority) PASS.

**Task 2 — Full WP-02/03/04/05 regression:**

```
forge build: No files changed, compilation skipped (clean)
forge test:  102 tests passed, 0 failed, 0 skipped (102 total)

Suite breakdown:
  ArcConstants.t.sol:    1 passed
  PactPool.t.sol:       19 passed
  FeeValidation.t.sol:  15 passed
  PactRegistry.t.sol:   31 passed
  Deployment.t.sol:      4 passed
  PactSettler.t.sol:    32 passed

test_DuplicateCallIdPrecedesRecipientCoverageMismatch: PASS (locked regression guard)
```

No regressions. WP-04 90/90 baseline preserved. Working tree uncontaminated (only
`?? .claude/pr-reviews/` — D-LOCK-6 check passed). No push, no PR #204 comment.

**Task 3 — GATE B checkpoint:** NOT resolved by this plan. Structured state returned to
orchestrator. Captain owns GATE B report + cockpit notice + WAIT.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | PORT inventory + N-A matrix + adversarial-pass review | c7ab3ed | .planning/phases/05-wp-evm-05-pactsettler-hardening/05-NA-MATRIX.md |
| 2 | Full WP-02/03/04/05 regression — 102/102 green | c3c2297 | (no code changes — regression record only) |

## WP-05 Deviation Flags for Captain Attention

### 05-04 stack-too-deep inline: intendedRefundAfterCap -> ev.refund (provably parity-neutral)

**Found during:** 05-04 Task 2 GREEN (PactSettler.sol compile).

**Issue:** Adding the `SettlementStatus status` local to `_settleSuccess` pushed the Solidity
stack frame over the limit. The existing locals (ev, ep, payableRefund, intendedRefundAfterCap,
totalFeePaid, feeAmount, actualRefund, ps) plus the new `status` exceeded the stack depth.

**Fix:** Inlined `intendedRefundAfterCap` as `ev.refund` at the call site (one stack slot saved).
Semantically identical: settle_batch.rs:380 seeds `intended_refund_after_cap = refund_lamports`
which equals `ev.refund`. The P1 inference comparison becomes `payableRefund < ev.refund` —
provably equivalent to the captain-ratified `payableRefund < intendedRefundAfterCap` since
`intendedRefundAfterCap == ev.refund` before any mutation. The `recordCallAndCapAccrual`
call-site arguments are UNCHANGED (P1 seam pin preserved).

**Parity impact:** None. The captain-ratified P1 predicate is preserved verbatim; only the
intermediate local is eliminated. The inference `payableRefund < ev.refund` is identical in
meaning and result to `payableRefund < intendedRefundAfterCap` at every boundary case.

**Status:** Flagged for captain ratification (auto-fixed Rule 3 — blocking; parity-neutral and
provably equivalent; test coverage confirms correct behavior via 3 green ExposureCap tests +
2 PoolDepleted tests that exercise the combined path).

**Commit:** 2157b75 (05-04 GREEN).

## Deviations from Plan

None in 05-06. The port inventory confirmed all PORT rows already covered; no new tests were
needed. The N-A matrix and adversarial-pass review were created as planned.

The 05-04 deviation (stack-too-deep inline) is documented above for captain attention — it was
auto-fixed in 05-04 and flagged here per the orchestrator instruction to surface it at GATE B.

## Known Stubs

None. All four WP-05 seams are fully implemented and tested. No placeholders remain in any
affected file. The plan's goal (SET-09..12 closure verification) is achieved.

## Threat Flags

None. This plan added only a documentation file (05-NA-MATRIX.md). No new network endpoints,
auth paths, file access patterns, or schema changes.

## Self-Check

### Files exist

```
[ -f ".planning/phases/05-wp-evm-05-pactsettler-hardening/05-NA-MATRIX.md" ] -> FOUND
```

### Commits exist

```
git log --oneline | grep c7ab3ed -> FOUND: docs(05-06): 05-NA-MATRIX.md
git log --oneline | grep c3c2297 -> FOUND: chore(05-06): full regression confirmed
```

### forge test result

```
102 tests passed, 0 failed, 0 skipped — CONFIRMED GREEN
test_DuplicateCallIdPrecedesRecipientCoverageMismatch: PASS
```

### No-push, no PR comment

No `git push` executed. No PR #204 comment posted. Verified: `git log origin/feat/arc-protocol-v1..HEAD` shows commits c7ab3ed and c3c2297 as unpushed local commits only.

## Self-Check: PASSED

All files present. Both commits exist. forge suite 102/102 green. Locked regression guard PASS. Working tree uncontaminated. No push. No PR comment. 05-NA-MATRIX.md has 10 N-A-ON-EVM occurrences (>= 6 required), no blockquote lines, no emoji bytes. WP-02 surviving-invariant tests all PASS.
