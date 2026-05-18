# WP-EVM-05 — Captain GATE A Verdict

Verified P1/P3/seam-slot against settle_batch.rs:400-414, :209-213, :462-469 and the WP-04 locked seams. Record all of this verbatim in the 05-01 GATE-A decision record; downstream plans cite it.

## P1 — ExposureCapClamped inference across the E1 split: RATIFIED (a)+(b)+(c)

(a) Inference predicate `payableRefund < intendedRefundAfterCap` APPROVED — verified provably equivalent to Solana's clamp condition at EVERY boundary:
- clamped: payable = cap_remaining, cap_remaining < intended -> predicate TRUE.
- not clamped: payable == intended -> predicate FALSE.
- `==` boundary: Solana clamp test is strict `intended > cap_remaining` at :402 (so intended == cap_remaining => NOT clamped); EVM strict `<` => FALSE. Match.
- intended == 0 (non-breach): Solana :400 guard `if intended_refund_after_cap > 0` skips the whole block; EVM `0 < 0` FALSE and refund only fires if payable > 0. Match.

(b) No-rollback invariant APPROVED — Solana never decrements current_period_refunds on a later PoolDepleted (:462-469 only sets status + actual_refund = 0); EVM recordRefundPaid is called only when actualRefund > 0, so no rollback path exists. Parity exact.

(c) Set ExposureCapClamped BEFORE the pool-balance check so PoolDepleted overwrites it — APPROVED, mirrors Solana :407-then-:468 (D-LOCK-CLAMP-ORDER).

CONSTRAINT HELD: do NOT change the seam-pinned recordCallAndCapAccrual signature (PactRegistry.sol:244-249); no bool/enum return.

CONDITIONS:
- The cap-clamp goes EXACTLY in the seam between the period-reset and the currentPeriodRefunds accrual (settle_batch.rs:400-408).
- currentPeriodRefunds accrues by the CLAMPED payableRefund (post-clamp), mirroring Solana :409-413 which uses the clamped intended_refund_after_cap.
- EVM saturatingSub parity-exact to Solana saturating_sub: never reverts/underflows; when currentPeriodRefunds > exposureCap, cap_remaining = 0 and everything clamps to 0.
- Pin with tests: (i) clamp-only -> status ExposureCapClamped, refund == cap_remaining, currentPeriodRefunds += clamped; (ii) clamp THEN pool-depleted -> status == PoolDepleted (overwrite), currentPeriodRefunds accrued by the clamped amount, totalRefunds UNCHANGED (no recordRefundPaid call, actualRefund == 0).

## P3 — protocol-paused vs onlyRole order: RATIFIED as OPTIMIZED-DIVERGENCE

Justification holds: the divergence is confined to the unauthorized-caller-AND-paused corner (an unauthorized caller is never a legitimate settler; 'not authorized' vs 'paused' is operationally meaningless for a caller who cannot settle anyway). The only alternative reopens/rewrites the LOCKED WP-04 E2 onlyRole settleBatch shape — a larger parity risk than the corner. This is a genuine section-4-class platform-mechanism divergence (Solana's weak-is_signer -> ProtocolPaused -> full-settler-identity two-stage check has no clean atomic-AccessControl EVM analog), NOT a reachable-meaningful precedence bug like the WP-04 dedup case the captain blocked. The distinction is consistent with prior rulings.

CONDITIONS:
- Do NOT reopen WP-04.
- Document the exact corner + rationale in the WP-06 parity matrix (the section (d) log).
- PORT operationally-real paths only. Tests: authorized settler + protocolPaused -> ProtocolPaused (pre-loop fast-revert); resume-after-unpause -> success; per-event EndpointPaused.
- Do NOT write a test asserting Solana behavior for the unauthorized+paused corner (EVM intentionally diverges there) — use a comment + the WP-06 matrix entry documenting that EVM returns AccessControlUnauthorizedAccount there.

## DECISION 3 — adversarial pass: APPROVED (brief, bounded)

Enable the BRIEF manual adversarial review scoped to the 4 WP-05 seams, exactly the 3 vectors proposed:
1. cross-agent cap saturation forcing another endpoint's ExposureCapClamped in one batch (FOLD IN the saturating_sub integer-boundary check: currentPeriodRefunds > exposureCap);
2. empty-batch (events.length == 0) pause-bypass;
3. reentrancy via registry.protocolPaused() / pool hooks on the PoolDepleted path.

NOT a fuzz suite (that is WP-06). Nyquist stays OFF per config. Keep it a scoped review, not a new test framework.

## Seam-slot confirmed correct

EndpointPaused inserts between the dedup READ (DuplicateCallId, :194) and RecipientCoverageMismatch (:213). Verified: Solana :209 (EndpointPaused) sits after dedup :194 and before RecipientCoverageMismatch :213. WP-04 test_DuplicateCallIdPrecedesRecipientCoverageMismatch must stay green (inserting EndpointPaused between them does not change that relation) — keep it as an explicit regression must_have.

## 6-plan chain (05-01..05-06): APPROVED

The serial depends_on chain (all 5 Solidity plans mutate PactSettler.sol/.t.sol -> serialized to prevent concurrent-edit corruption under the parallelization config) is correct. The plan-checker catch + surgical frontmatter fix was the right call. Mandatory and enforced: additive-only grep-negative criteria blocking WP-04 edits, and the 90/90 WP-04 forge regression must_have on every plan. Do NOT reopen any WP-02/03/04 code; WP-05 only FILLS the seams.

## Proceed

Finalize the 05-01 GATE-A decision record citing this verdict verbatim, then /gsd:execute-phase 05-02 -> 05-06 (strict TDD red-before-green, file-scoped commits, Solana source authority, STOP-AND-ASK on any parity ambiguity). GATE B = after impl + forge build && forge test green (WP-04 90/90 regression + new WP-05 tests): write 05-REPORT-gateB.md + cockpit notice, WAIT, NO push / NO PR #204 comment until captain approval.
