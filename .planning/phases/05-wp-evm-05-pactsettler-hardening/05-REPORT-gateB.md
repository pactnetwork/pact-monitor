# WP-EVM-05 — GATE B Report (request — captain parity sign-off)

**Date:** 2026-05-19
**Crew:** WP-EVM-05 (fresh resume; continued `feat/arc-protocol-v1`)
**Status:** Implementation COMPLETE. All 4 seams filled, all GATE-A rulings
implemented verbatim, full regression independently verified GREEN by the
orchestrator. AWAITING captain GATE B verdict. NO push. NO PR #204 comment.
Working tree clean (only `?? .claude/pr-reviews/`; CLAUDE.md unmodified; no
`.claude/skills/pact/` — no contamination).

## Forge result (orchestrator-independent verification, not relayed)

`forge build`: clean (only pre-existing unused-import lint notes, none
introduced by WP-05). `forge test`: **102 passed, 0 failed, 0 skipped**
across 6 suites — ArcConstants 1, Deployment 4, PactPool 19, PactRegistry 31,
FeeValidation 15, PactSettler 32. WP-04 baseline was 90 (PactSettler 20);
WP-05 added 12 PactSettler tests (20 -> 32); 90 WP-04 regression preserved.
`test_DuplicateCallIdPrecedesRecipientCoverageMismatch` (the WP-04 LOCKED
precedence pin) PASS — D-LOCK-PREC intact. This count was reproduced by the
orchestrator directly, not taken from the executor's claim.

## The 4 seams — implemented, parity-checked against settle_batch.rs

1. **ProtocolPaused + BatchTooLarge (05-02, SET-11/12).** Inserted as the
   first two statements of the `settleBatch` body, before the loop:
   `if (registry.protocolPaused()) revert ProtocolPaused();` then
   `if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();`.
   Ports `settle_batch.rs:99-115` then `:132-135` in that order (Pitfall 3
   avoided). Strict `>` (50 OK, 51 reverts). P3 OPTIMIZED-DIVERGENCE honored:
   only authorized-settler+paused and resume-after-unpause tested; the
   unauthorized+paused corner is documented in 05-NA-MATRIX.md, not tested.
2. **EndpointPaused (05-03, SET-11).** One line
   `if (ep.paused) revert EndpointPaused();` inserted at the D-LOCK-PREC slot:
   after the `getEndpoint` read, after the DuplicateCallId dedup READ, before
   `RecipientCoverageMismatch`. Ports `settle_batch.rs:209`. The WP-04 placeholder
   comment was the only line removed; dedup READ (line 94) < EndpointPaused
   (102) < RecipientCoverageMismatch (104) < dedup SET (111). The LOCKED
   precedence test stays green; a dedup-READ-precedes-EndpointPaused ordering
   test was added.
3. **ExposureCapClamped + P1 inference (05-04, SET-10).** Cap clamp inserted
   in `PactRegistry.recordCallAndCapAccrual` EXACTLY between the WP-04 period
   reset and the `currentPeriodRefunds` accrual; ternary `capRemaining`
   parity-exact to Solana `saturating_sub` (no underflow; clamps to 0 when
   `currentPeriodRefunds >= exposureCap`). `recordCallAndCapAccrual` signature
   UNCHANGED (P1 seam pin held). P1 inference in `_settleSuccess`:
   `SettlementStatus status = Settled` set after the (arg-unchanged) call and
   before the pool-balance check; `if (payableRefund < ev.refund) status =
   ExposureCapClamped`. Ports `settle_batch.rs:400-414`. `currentPeriodRefunds`
   accrues the clamped amount, never rolled back (P1(b)).
4. **PoolDepleted (05-05, SET-09).** The previously-empty
   `if (ps.currentBalance < payableRefund) {}` block filled with EXACTLY
   `status = SettlementStatus.PoolDepleted; actualRefund = 0;`. Ports
   `settle_batch.rs:462-469`. The WP-04 `else` (payout + debitForRefund +
   actualRefund) is byte-unchanged; `recordRefundPaid` (WP-04, only when
   `actualRefund > 0`) correctly skips on the depleted path; no
   `currentPeriodRefunds` rollback. D-LOCK-CLAMP-ORDER proven by the combined
   test: PoolDepleted overwrites ExposureCapClamped (set later in code order),
   `currentPeriodRefunds` accrued by the clamped amount, `totalRefunds`
   unchanged.

## DEVIATION flagged for captain ratification (parity-neutral, diff-spot-checkable)

05-04 introduced the mandatory `SettlementStatus status` local in
`_settleSuccess`, which pushed Solidity over the stack-slot limit. The
executor applied a Rule-3 auto-fix: inlined the WP-04 local
`uint64 intendedRefundAfterCap = ev.refund;` to `ev.refund` at the
`recordCallAndCapAccrual` call site (frees one stack slot). I verified this is
provably parity-neutral, not a logic change:

- WP-04 declared `intendedRefundAfterCap = ev.refund` and NEVER mutated it
  before the call (it was a pure WP-05-staging alias; `ev.refund` is calldata,
  read-only — grep confirms zero reassignment anywhere in `_settleSuccess`).
- The captain-ratified P1 predicate was `payableRefund < intendedRefundAfterCap`.
  Since `intendedRefundAfterCap == ev.refund` identically at that point, the
  emitted predicate `payableRefund < ev.refund` is byte-equivalent. Solana
  seeds `intended_refund_after_cap = refund_lamports` (`settle_batch.rs:380`),
  and EVM `ev.refund` IS `refund_lamports`, so the equivalence to Solana
  `intended > cap_remaining` holds at every boundary (the `==` boundary and
  the `intended==0` non-breach case both behave identically).
- The seam-pinned `recordCallAndCapAccrual` SIGNATURE and the value passed are
  unchanged (still `(slug, premium, breach, ev.refund)`); no new return; the
  P1 mechanism, no-rollback, and set-before-pool-check precedence are all as
  ratified. No economic logic was altered; 102/102 green incl. the combined
  cap+pool precedence test.

This is the one item where a WP-04 line (a local-variable alias) was touched.
It was compiler-forced, documented in commit `2157b75`, and is provably
semantics-preserving. Surfaced here for the captain's GATE-B diff spot-check
to ratify (same posture as the WP-04 GATE-B diff review) or direct otherwise.

## N-A matrix + adversarial pass (05-NA-MATRIX.md)

7 N-A-ON-EVM rows (09:47/78/144/172, 10:94/128 PDA/owner-spoof;
D-LOCK-EXPCAP-NA `ExposureCapExceeded` has no settle trigger) — each with a
one-line WP-06 parity-matrix rationale and the named WP-02 surviving
authority-invariant test (`test_PauseEndpoint_RejectsNonAuthority`,
`test_PauseProtocol_RejectsNonAuthority`,
`test_UpdateEndpointConfig_RejectsNonAuthority`,
`test_UpdateFeeRecipients_RejectsNonAuthority` — all confirmed PASS). The P3
OPTIMIZED-DIVERGENCE corner (unauthorized+paused -> AccessControlUnauthorizedAccount
on EVM vs ProtocolPaused on Solana; authorized+paused identical on both) is
recorded for the WP-06 parity matrix per the GATE-A ruling. The brief bounded
adversarial pass (3 vectors, not a fuzz suite, per GATE-A): V1 cross-agent cap
saturation / saturatingSub=0 boundary — CLEAN (covered by
`test_ExposureCap_CumulativeClampAcrossBatches`); V2 empty-batch
(`events.length==0`) pause-bypass — CLEAN (`protocolPaused()` fires pre-loop,
cannot be bypassed); V3 reentrancy via `protocolPaused()`/pool hooks on the
PoolDepleted path — CLEAN (no external call on the depleted branch; dedup SET
precedes premium-in). No real vector findings; no extra tests needed.

## Locked-law preservation

D-LOCK-PREC: EndpointPaused inserted additively at the dedup-READ ->
RecipientCoverageMismatch slot; `test_DuplicateCallIdPrecedesRecipientCoverageMismatch`
PASS. D-LOCK-CLAMP-ORDER: code order = cap-clamp then pool-check; final-status
precedence PoolDepleted > ExposureCapClamped > Settled proven by the combined
test; no `currentPeriodRefunds` rollback. P1: implemented exactly as ratified
(inference predicate, no-rollback, set-before-pool-check, signature pin,
saturating_sub parity incl. the `>exposureCap=>0` boundary). P3: OPTIMIZED-
DIVERGENCE, operationally-real paths only, corner in the WP-06 matrix. No
WP-02/03/04 reopen/rewrite/reorder except the single compiler-forced
parity-neutral alias inline flagged above. 90/90 WP-04 regression preserved.
Strict TDD RED-before-GREEN on every implementation task; file-scoped
conventional commits, no emojis, pnpm/forge (never npm).

## Commit lineage (on feat/arc-protocol-v1, oldest -> newest)

GATE-A: `111bc8a` decision record. 05-02: `89f43b7` RED · `26c6d3c` GREEN ·
`155b096` bookkeeping. 05-03: `c14a254` RED · `5e47e3a` GREEN · `385f7b5`
bookkeeping. 05-04: `7eecfdb` RED · `323699e` GREEN cap clamp · `2157b75`
GREEN P1 inference (the flagged inline) · `d7ee074` bookkeeping. 05-05:
`5954ba3` RED · `5339316` GREEN · `3bf2a45` bookkeeping. 05-06: `c7ab3ed`
NA-matrix+adversarial · `c3c2297` regression-confirmed · `7bfb683`
bookkeeping. Not pushed.

## What I need from the captain (GATE B verdict)

1. Spot-check the flagged 05-04 inline (`2157b75`) — ratify it as
   parity-neutral, or direct a different stack-too-deep resolution.
2. Approve GATE B (102/102, 4 seams parity-correct, locked law preserved).

On approval I will run the gsd-verifier closeout (05-VERIFICATION.md), mark
the phase complete in STATE/ROADMAP, then per the cadence the captain drives
push + PR #204. NO push / NO PR #204 comment until you approve. WAITING.
