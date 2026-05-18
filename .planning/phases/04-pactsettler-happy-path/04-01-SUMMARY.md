---
phase: 04-pactsettler-happy-path
plan: 01
status: complete
completed: 2026-05-18
self_check: PASSED
---

# 04-01 SUMMARY — GATE-A decision record

**Outcome:** The 04-01 `checkpoint:decision` is RESOLVED. The captain reviewed
04-CONTEXT.md + 04-RESEARCH.md + settle_batch.rs and ruled all four GATE-A
decisions on 2026-05-18. The canonical, verbatim record is
`04-GATE-A-DECISIONS.md` (committed `05443db`); downstream plans cite it.

## Captain rulings (verbatim source: 04-GATE-A-DECISIONS.md)

- **D-SPLIT:** APPROVED (reading A — WP-04 = 9 happy-path tests; 4
  clamp/killswitch tests → WP-05), REFINED: the hourly-window PERIOD RESET
  (`settle_batch.rs:396-399`) AND `current_period_refunds += intended`
  (`:409-414`) are WP-04 happy-path state (in the E1 registry hook). ONLY the
  3 clamp DECISIONS (ExposureCapClamped, PoolDepleted, protocol/endpoint
  pause) are WP-05, layered additively; WP-04 preserves source mutation ORDER
  exactly with clean insertion points.
- **E1 = OPTION (a) RULED:** extend `PactRegistry` with SETTLER_ROLE-gated
  endpoint-stats hook(s) symmetric to the WP-03 PactPool hooks. Conditions
  (1) OZ AccessControl + SETTLER_ROLE same pattern as PactPool;
  (2) mutations bit-identical to `settle_batch.rs:385-499`, same order, all
  checked → `ArithmeticOverflow`; (3) PURE ADDITION — WP-02 PactRegistry.t.sol
  + 70 tests stay green + new hook tests; (4) this REFINES WP-03 D1 scope
  (not a contradiction) — recorded in STATE.md, append to handoff
  locked-rulings (ruling #8) at WP-06 §d. Unblocks SET-07 (+ ep.* of
  SET-05/06).
- **E2 = CONFIRM lead RULED:** OZ AccessControl SETTLER_ROLE on PactSettler;
  ctor 4→3-arg; `DEFAULT_ADMIN_ROLE → registry.authority()`; Deployment.t.sol
  3-arg; deployed PactSettler granted SETTLER_ROLE on BOTH PactPool AND
  PactRegistry. Unblocks SET-01.
- **E3 = CONFIRM lead RULED:** emit ONLY `IPactSettler.CallSettled` (typed
  enum); `PactEvents.CallSettled` is the indexer alias, no second emission;
  add ABI-identity assertion. Unblocks SET-08.
- **E4 = CONFIRM lead RULED, MUST-VERIFY RESOLVED FROM SOURCE:** CallRecord →
  CallSettled event-as-truth + `mapping(bytes16=>bool)` dedup; source confirms
  the call_id is consumed even on `DelegateFailed` (`settle_batch.rs:243-247`
  comment + `:255` create_account + `:332-352`) — dedup set BEFORE premium-in
  try/catch; one CallSettled per call incl. DelegateFailed. Unblocks
  SET-06/SET-08.
- **Config flag:** Nyquist/security GSD gates DISABLED for WP-04 (ported
  LiteSVM oracle + strict TDD is the validation contract). WP-05 enables a
  settlement threat-model/adversarial pass; WP-06 fuzz/gas covers statistical
  adequacy.
- **Reporting:** gate reports → `.planning/phases/<phase>/<phase>-REPORT-<gate>.md`
  + short cockpit notice.

## Artifacts

- `04-GATE-A-DECISIONS.md` — canonical verbatim ruling record (4 `## E`
  sections; D-SPLIT; config + reporting; proceed directive).
- `04-REPORT-gateA.md` — GATE A outcome report (incl. the parity-seam defect
  caught + corrected: E1 hook split into `recordCallAndCapAccrual` +
  `recordRefundPaid` to mirror the two source ep.* mutation points).
- 04-CONTEXT.md updated (refined boundary, resolved E1-E4); STATE.md updated
  (D1-scope refinement, config, reporting). Plans 02/03/04 revised + re-checked
  PASSED (iteration 3).

## Self-Check: PASSED

- 04-GATE-A-DECISIONS.md exists; `grep -c "^## E"` == 4; contains "SET-07"
  and "SET-01"; each E-section has Decision/Options/Requirements
  unblocked/Downstream tasks blocked/Recommended resolution.
- No `.sol` file modified by this plan (decision-record only): `git status
  --porcelain packages/program-evm` empty for src/test.
- Captain ruling recorded for each of E1-E4. Phase cleared to proceed to
  plan 02.
