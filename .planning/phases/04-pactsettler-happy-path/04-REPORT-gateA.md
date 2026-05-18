# WP-EVM-04 — GATE A Report (outcome)

**Date:** 2026-05-18
**Crew:** WP-EVM-04 (fresh resume)
**Status:** GATE A CLEARED by captain. Decisions ruled, plans finalized +
re-verified. Proceeding to `/gsd:execute-phase 04` (plans 02->04), next stop
GATE B. No Solidity written yet. No push, no PR #204 comment.

## What happened since the GATE A request

1. Captain ruled GATE A (D-SPLIT approved+refined; E1=(a)+4 conditions;
   E2/E3/E4 confirm-lead; config flag; reporting-protocol change).
2. Recorded all rulings verbatim in `04-GATE-A-DECISIONS.md` (canonical;
   satisfies plan 04-01's deliverable — the 04-01 checkpoint:decision is
   resolved).
3. Updated `04-CONTEXT.md`: GATE-A REFINEMENT block, RESOLVED E1-E4,
   corrected per-event step 7 (period reset is WP-04).
4. Revised plans (gsd-planner, targeted) + re-verified (gsd-plan-checker)
   THREE iterations; final = VERIFICATION PASSED.
5. E4 MUST-VERIFY resolved from source (NOT ambiguous): `settle_batch.rs`
   :243-247 comment + :255 `create_account` + :332-352 — the call_id is
   consumed even on `DelegateFailed`; EVM mirrors this (dedup mapping set
   BEFORE the premium-in try/catch; one CallSettled per call incl.
   DelegateFailed).
6. D1-scope refinement recorded in STATE.md + 04-GATE-A-DECISIONS.md; to be
   appended to the handoff locked-rulings list (ruling #8) at the WP-06 §d
   formal-correction pass.

## Parity-seam defect CAUGHT and CORRECTED (flagging for visibility)

The first revision's 04-04 consolidated `settle_batch.rs`'s TWO distinct
`ep.*` mutation points (block 1 :385-414 BEFORE fee fan-out, containing the
period reset + `current_period_refunds += intended`; and `ep.total_refunds +=
actual` :493-499 AFTER the refund transfer) into ONE `recordSettlement(...)`
call placed after `actualRefund` was known. The plan-checker rated this
"non-blocking / Claude's Discretion / net-state-equal." I escalated it to a
BLOCKER: it did NOT "preserve settle_batch.rs mutation ORDER exactly" and it
broke the WP-05 seam (the exposure-cap clamp must read post-reset
`current_period_refunds` and drive the transfer amount BEFORE the transfer —
impossible if reset+accrual live in a post-transfer hook without WP-05
rewriting WP-04). The captain explicitly forbade "a happy-path-only shape
WP-05 must rewrite." Source is unambiguous (two mutation points, fixed order)
so this was a source-vs-plan conflict resolved TO THE SOURCE, not a guess.

Fix applied + re-verified PASSED: the E1 registry hook is SPLIT to mirror the
two source mutation points exactly:
- `recordCallAndCapAccrual(slug, premium, breach, intendedRefund) onlyRole
  (SETTLER_ROLE) returns (uint64 payableRefund)` — ep point 1, called BEFORE
  fee fan-out: total_calls -> total_premiums -> (breach) total_breaches ->
  PERIOD RESET (:396-399) -> [WP-05 cap-clamp seam] -> currentPeriodRefunds
  += payableRefund (:409-414); returns payableRefund (== intendedRefund in
  WP-04, no clamp).
- `recordRefundPaid(slug, actualRefund) onlyRole(SETTLER_ROLE)` — ep point 2,
  called AFTER the refund transfer: totalRefunds += actualRefund (:493-499).
WP-05 inserts the cap clamp INSIDE recordCallAndCapAccrual (between reset and
accrual, adjusting the return) and the PoolDepleted branch in the empty
settleBatch `if` — both additive, ZERO WP-04 rewrite. Captain may override if
this read of the seam requirement is wrong.

## Final plan shape (re-verified PASSED, iteration 3)

- 04-01 — GATE-A decision record. SATISFIED (captain ruled;
  04-GATE-A-DECISIONS.md finalized).
- 04-02 — Foundation: PactSettler OZ AccessControl SETTLER_ROLE + 3-arg ctor
  (E2); PactRegistry gains OZ AccessControl + the SPLIT SETTLER_ROLE-gated
  endpoint-stats hooks (E1(a), 4 conditions, period reset in hook 1);
  PactSettler.t.sol harness with two-layer role grant on BOTH PactPool AND
  PactRegistry. TDD; pure-addition regression gate (WP-02 PactRegistry.t.sol
  + 70 tests stay green).
- 04-03 — Per-event guards (MIN_PREMIUM/timestamp/feeCountHint) + dedup
  mapping set BEFORE premium-in try/catch + premium-in raw `try IERC20
  .transferFrom` -> DelegateFailed (E4). TDD. SET-01..04.
- 04-04 — settleBatch composition in EXACT source order (cp credit -> ep
  point 1 pre-fan-out -> fee fan-out floor-div `uint64(uint256(premium)*bps/
  10_000)` -> refund transfer w/ empty PoolDepleted seam -> ep point 2
  post-transfer -> one CallSettled per call, E3 single typed-enum emission +
  ABI-identity assertion). The 9 ported happy-path `05` tests, exact numbers
  verbatim. GATE-B task writes `04-REPORT-gateB.md` + cockpit notice + STOPS
  (no push / no PR #204). SET-05..08.
- SET-01..SET-08 fully covered. Strict TDD RED-before-GREEN every code task.
  WP-05 leakage blocked by PactSettler.sol-scoped grep-negative criteria
  (period reset/accrual in PactRegistry.sol exempt by design).

## Proceeding

Executing `/gsd:execute-phase 04` now (02->03->04). STOP-AND-ASK on any
parity ambiguity (source authority). Will halt at GATE B and write
`04-REPORT-gateB.md` + send a cockpit notice; no push / no PR until captain
approves GATE B.
