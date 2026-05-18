---
phase: 05-wp-evm-05-pactsettler-hardening
plan: 01
subsystem: testing
tags: [parity-port, gate-a, decision-record, solidity, settle-batch]

requires:
  - phase: 04-pactsettler-happy-path
    provides: WP-04 LOCKED E1-E4, the 4 clean WP-05 seams, guard precedence
provides:
  - Canonical GATE-A decision record (05-GATE-A-DECISIONS.md) with captain's verbatim P1/P3/adversarial/seam-slot/6-plan rulings
  - Unblocks 05-02..05-06 to cite settled law (no re-derivation)
affects: [05-02, 05-03, 05-04, 05-05, 05-06, wp-evm-06-parity-matrix]

tech-stack:
  added: []
  patterns: ["GATE-A decision record mirrors 04-GATE-A-DECISIONS.md; captain verdict cited verbatim"]

key-files:
  created:
    - .planning/phases/05-wp-evm-05-pactsettler-hardening/05-GATE-A-DECISIONS.md
  modified: []

key-decisions:
  - "P1 RATIFIED (a)+(b)+(c): inference predicate payableRefund < intendedRefundAfterCap (equivalent at all boundaries), no-rollback, set ExposureCapClamped before pool-balance check so PoolDepleted overwrites; recordCallAndCapAccrual signature pinned UNCHANGED"
  - "P3 RATIFIED as OPTIMIZED-DIVERGENCE: port operationally-real paths only; unauthorized+paused corner documented in WP-06 matrix, no test asserting Solana behavior there"
  - "DECISION 3 APPROVED: brief bounded adversarial pass, 3 vectors, saturating_sub boundary folded into vector 1; not a fuzz suite; Nyquist OFF"
  - "Seam-slot confirmed: EndpointPaused between dedup READ (:194) and RecipientCoverageMismatch (:213); WP-04 test_DuplicateCallIdPrecedesRecipientCoverageMismatch stays green (regression must_have)"
  - "6-plan serial chain 05-01..05-06 APPROVED; additive-only + 90/90 regression enforced; do NOT reopen WP-02/03/04"

patterns-established:
  - "Captain GATE-A verdict delivered as a file (channel shell-mangles chars); decision record cites it verbatim, blockquote-free, emoji-free"

requirements-completed: [SET-09, SET-10, SET-11, SET-12]

duration: 1min
completed: 2026-05-18
---

# Phase 05 / Plan 01: GATE-A Decision Record Summary

**Captain ruled the two OPEN parity decisions (P1 inference across the E1 split, P3 protocol-paused/onlyRole order) plus the adversarial-pass and 6-plan-chain decisions; recorded verbatim in 05-GATE-A-DECISIONS.md — phase GATE-A gate satisfied, no Solidity written.**

## What happened

The orchestrator presented `05-REPORT-gateA.md` to the captain and WAITED. The
captain returned a file verdict (`05-CAPTAIN-GATE-A-VERDICT.md`). All four
decisions were ruled:

- **P1** RATIFIED (a)+(b)+(c) with conditions and two pinning tests; the
  seam-pinned `recordCallAndCapAccrual` signature stays UNCHANGED.
- **P3** RATIFIED as OPTIMIZED-DIVERGENCE; port operationally-real paths only;
  the unauthorized+paused corner goes to the WP-06 parity matrix (no Solana-
  behavior test for that corner on EVM).
- **DECISION 3** APPROVED — brief bounded 3-vector adversarial pass; the
  `saturating_sub` integer-boundary check folds into vector 1.
- **Seam-slot** confirmed; **6-plan serial chain** APPROVED with additive-only
  and 90/90-regression must_haves enforced.

The verbatim rulings are recorded in
`.planning/phases/05-wp-evm-05-pactsettler-hardening/05-GATE-A-DECISIONS.md`
(6 `##` sections, RULED status, recordCallAndCapAccrual pin recorded, zero
blockquote lines, zero emojis). Plan 05-01's `checkpoint:decision` gate is
RESOLVED; 05-02..05-06 are unblocked to cite this as settled law.

## Verification

- `test -f 05-GATE-A-DECISIONS.md` -> yes
- `grep -c '^## '` -> 6 (>= 3)
- `grep -q 'RULED'` -> yes
- `grep -q 'recordCallAndCapAccrual'` -> yes
- blockquote lines (`^\s*>`) -> 0; emoji bytes -> 0

## Next

`/gsd:execute-phase` 05-02 -> 05-06 in the serial chain. Strict TDD
RED-before-GREEN, file-scoped conventional commits, Solana source authority,
STOP-AND-ASK on parity ambiguity, no reopening of WP-02/03/04. Halt at GATE B:
write `05-REPORT-gateB.md` + cockpit notice, WAIT, no push / no PR #204.
