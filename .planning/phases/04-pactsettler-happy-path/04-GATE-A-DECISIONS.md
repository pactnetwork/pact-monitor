# WP-EVM-04 — GATE A Decision Record

**Status:** RULED by captain 2026-05-18. Settled law for WP-EVM-04 execution.
Plans 04-02/03/04 cite these verbatim. This record finalizes plan 04-01's
deliverable (the 04-01 `checkpoint:decision` is satisfied — captain has ruled).

**Source authority:** `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs`.
Where any plan/spec/scaffold prose conflicts with this record or with
`settle_batch.rs`, the Rust source wins (handoff D-LOCK-1).

---

## D-SPLIT — WP-04/WP-05 boundary (APPROVED, reading A, REFINED)

**Captain ruling (verbatim):**

> D-SPLIT: APPROVED (reading A — WP-04 = the 9 happy-path tests; the 4
> clamp/killswitch tests -> WP-05). CONDITION: the hourly-window period
> accounting is HAPPY-PATH state, NOT WP-05. Per settle_batch.rs:397-412,
> EVERY settled refund does: the period reset (if now > current_period_start +
> 3600 -> current_period_start=now, current_period_refunds=0) AND
> current_period_refunds += refund. WP-04 implements those. ONLY the clamp
> DECISIONS are WP-05: (i) ExposureCapClamped when intended_refund >
> cap_remaining (the saturating_sub clamp branch), (ii) PoolDepleted when
> pool_balance < intended_refund, (iii) Protocol/endpoint pause kill-switches.
> WP-04 settleBatch MUST preserve settle_batch.rs mutation ORDER exactly and
> leave clean insertion points so WP-05 layers the 3 clamps additively — do
> NOT build a happy-path-only shape WP-05 must rewrite.

**Binding consequences (this OVERRIDES 04-CONTEXT.md / 04-RESEARCH.md §Q5 and
the plan-checker's earlier line classification):**

- WP-04 IMPLEMENTS, in exact `settle_batch.rs` order:
  - `:385` `ep.total_calls += 1` (checked_add → `ArithmeticOverflow`)
  - `:386-389` `ep.total_premiums += premium` (checked_add)
  - `:390-395` if breach: `ep.total_breaches += 1` (checked_add)
  - `:396-399` PERIOD RESET — `if now > ep.current_period_start + 3600 {
    ep.current_period_start = now; ep.current_period_refunds = 0 }`  **← WP-04**
  - `:409-414` `ep.current_period_refunds += intended_refund_after_cap`
    (checked_add)  **← WP-04**
  - `:483-486` `cp.current_balance -= actual_refund` (checked_sub)
  - `:487-490` `cp.total_refunds += actual_refund` (checked_add)
  - `:493-499` `ep.total_refunds += actual_refund` (checked_add)
- WP-04 leaves CLEAN ADDITIVE INSERTION POINTS for the 3 WP-05 clamps; it does
  NOT implement them and MUST NOT be shaped so WP-05 has to rewrite it:
  - (i) ExposureCapClamped: `:401-408` — `cap_remaining =
    exposure_cap_per_hour.saturating_sub(current_period_refunds); if
    intended_refund_after_cap > cap_remaining { intended_refund_after_cap =
    cap_remaining; status = ExposureCapClamped }`. In WP-04 the local
    `intendedRefundAfterCap` is seeded from `ev.refund` and never reduced (the
    clamp branch is absent); the variable + the `if intendedRefundAfterCap > 0`
    guards exist so WP-05 inserts the clamp between them additively.
  - (ii) PoolDepleted: `:462-469` — `if pool_balance <
    intended_refund_after_cap { status = PoolDepleted; actual_refund = 0 }`.
    WP-04 implements only the `else` (sufficient-balance) branch; the refund
    transfer + debits sit in a branch WP-05 turns into the `else` of the
    pool-balance check without rewriting.
  - (iii) Protocol/endpoint pause kill-switches — pre-loop + per-event;
    entirely WP-05.
- **Parity nuance the revision MUST honor:** `current_period_refunds` (`:410`)
  accumulates the post-cap INTENDED amount; `ep.total_refunds` / `cp.*`
  (`:483-499`) use the ACTUAL paid amount. In the WP-04 happy path
  intended == actual (no clamp, pool funded), but the E1 hook + settleBatch
  composition must take/record these as DISTINCT inputs so WP-05's clamp (where
  intended != actual) layers in additively with NO rewrite. Caller passes
  intended==actual in WP-04.
- The 9 WP-04 tests (per D-SPLIT reading A): DefaultTreasuryFanOut,
  Explicit85_10_5Split, BreachRefundsAgentFromPool, MixedBatch3Endpoints,
  RevokeMarksDelegateFailedAndContinues, MinPremiumEdgeRejected,
  DuplicateCallIdRejected, UnauthorizedSettlerRejected,
  HappyPathSettledStatusEvent. The 4 deferred (WP-05): pool-depleted,
  exposure-cap-clamp, protocol-paused, pause→unpause.

---

## E1 — Endpoint-stats write path (PRIMARY) — RULED: OPTION (a)

**Decision:** Where the per-event `EndpointConfig` stat mutations of
`settle_batch.rs:385-499` are persisted on EVM.

**settle_batch.rs evidence:** `:385-499` mutates `ep.total_calls`,
`ep.total_premiums`, `ep.total_breaches`, `ep.current_period_start`,
`ep.current_period_refunds`, `ep.total_refunds`. `IPactRegistry` exposes only
reads (`getEndpoint`/`isRegistered`) — no settler-gated stat writer (the E1
gap).

**Options:** (a) extend `PactRegistry` with SETTLER_ROLE-gated endpoint-stats
hook(s) symmetric to the WP-03 `PactPool` settler hooks [RULED]; (b) hold
endpoint stats in `PactSettler` storage [architectural split, spec-§6
divergent, `getEndpoint` returns stale stats — REJECTED]; (c) no persistence
[fails SET-07 — REJECTED].

**Captain ruling (verbatim):**

> E1 (PRIMARY) = OPTION (a): extend PactRegistry with SETTLER_ROLE-gated
> endpoint-stats hook(s), symmetric to the WP-03 PactPool settler hooks (§4#5
> OZ AccessControl). This is the only spec-§6-faithful, parity-correct option
> (EndpointConfig is registry state; getEndpoint/indexer read it together;
> (b) splits state + returns stale stats; (c) fails SET-07). RULING ON THE D1
> TENSION: WP-03's D1 'no modify committed WP-02 PactRegistry' was SCOPED to
> PactPool's pool-existence reach (read-only registry ref) — it is NOT a
> prohibition on WP-04 adding its own properly-gated stat-writer to the
> registry where spec §6 puts that state. This is a sanctioned, ADDITIVE,
> scoped extension. CONDITIONS: (1) PactRegistry gains OZ AccessControl +
> SETTLER_ROLE, SAME pattern as PactPool (ctor grants DEFAULT_ADMIN_ROLE to
> the same authority; deployed PactSettler granted the registry's
> SETTLER_ROLE); (2) the stat mutations are BIT-IDENTICAL to
> settle_batch.rs:385-498 — total_calls+=1, total_premiums+=premium,
> total_breaches+=1 on breach, the period reset, current_period_refunds+=refund,
> total_refunds+=actual_refund — ALL checked_* -> ArithmeticOverflow named
> error, SAME ORDER as the Rust; (3) PURE ADDITION — every existing WP-02
> PactRegistry test must stay green (re-run full suite, regression gate) + new
> tests for the stat hooks (role-gated, arithmetic, ordering, period reset);
> (4) record in 04-GATE-A-DECISIONS.md that this captain ruling refines D1's
> scope (not a contradiction) and add it to the handoff locked-rulings list.

**D1 scope refinement (condition 4 — recorded here):** WP-03 ruling D1 ("NO
modification of committed WP-02 `PactRegistry`") is hereby REFINED, not
contradicted: D1 prohibited `PactPool` reaching into the registry beyond a
read-only reference. It does NOT prohibit WP-04 adding its own SETTLER_ROLE-
gated endpoint-stats writer to `PactRegistry`, which is where design-spec §6
places `EndpointConfig` state. To be appended to the handoff locked-rulings
list as ruling #8 (handoff §b) during WP-06's formal-correction pass (handoff
§d), and noted in STATE.md now.

**Requirements unblocked:** SET-07 (stats accounting) and the `ep.*` portions
of SET-05 / SET-06.

**Downstream tasks blocked on this ruling:** 04-02 Task 2 (E1 stat hook +
AccessControl on PactRegistry), 04-02 Task 3 (harness two-layer role grant
incl. registry), 04-04 Task 1/2 (settleBatch composes the hook in source
order), 04-04 GATE-B regression.

**Recommended/ruled resolution:** OPTION (a) with conditions (1)-(4) above,
INCLUDING the period reset per the D-SPLIT refinement (the earlier plan text
"do NOT add the period reset" is OVERRIDDEN — the reset IS in the E1 hook).

---

## E2 — SETTLER_ROLE gate location — RULED: CONFIRM lead

**Decision:** How `PactSettler` enforces the settler-role gate (needed for the
`05` "unauthorized settler rejected" test) and how it is wired.

**Scaffold evidence:** `PactSettler.sol:29-38` — plain `address settler`,
4-arg ctor, `TODO(WP-EVM-05)` AccessControl note (a superseded WP-01 sketch
per D-LOCK-1).

**Options:** research lead (OZ AccessControl, 3-arg ctor) [RULED]; alternative
(keep an initial-admin ctor arg) [not taken].

**Captain ruling (verbatim):**

> E2 = CONFIRM lead: OZ AccessControl SETTLER_ROLE on PactSettler, ctor
> 4-arg->3-arg (drop address settler_), DEFAULT_ADMIN_ROLE -> registry.authority()
> (exact PactPool pattern), Deployment.t.sol test_DeployPactSettler -> 3-arg
> (same in-scope scaffold-fix as WP-02/03 D5). The scaffold TODO(WP-EVM-05) is
> a superseded WP-01 sketch. INTERPLAY: with E1(a) the deployed PactSettler
> must hold SETTLER_ROLE on BOTH PactPool AND PactRegistry — wire that in
> deployment + test setup.

**Requirements unblocked:** SET-01.

**Downstream tasks blocked on this ruling:** 04-02 Task 1 (PactSettler
AccessControl + ctor change), 04-02 Task 3 (Deployment.t.sol 3-arg + two-layer
grant on pool AND registry), 04-03/04-04 (`onlyRole(SETTLER_ROLE)` on
`settleBatch`).

**Recommended/ruled resolution:** research lead CONFIRMED; deployed
`PactSettler` granted `SETTLER_ROLE` on BOTH `PactPool` and `PactRegistry`.

---

## E3 — CallSettled event consolidation — RULED: CONFIRM lead

**Decision:** Whether to emit one `CallSettled` (the `IPactSettler` typed-enum
declaration) and treat `PactEvents.CallSettled` (`uint8 status`) as an
indexer-facing alias.

**Evidence:** `IPactSettler.sol` `CallSettled(... SettlementStatus status ...)`
vs `PactEvents.sol` `CallSettled(... uint8 status ...)`. Solidity canonicalizes
an enum to its underlying `uint8` in event signatures, so topic0 and field
ABI are identical for both declarations.

**Options:** research lead (emit only IPactSettler form, no second emission)
[RULED]; alternative (emit PactEvents uint8 form) [not taken].

**Captain ruling (verbatim):**

> E3 = CONFIRM lead: emit ONLY IPactSettler.CallSettled (typed enum);
> PactEvents.CallSettled is the indexer-facing alias, NO second emission
> (exactly one CallSettled per call). CONDITION: assert the two declarations
> are byte-ABI-identical (same topic0 / field order/types) so 'alias' is
> literally true; record for the WP-06 parity matrix (§4#3 event model).

**ABI-identity verification (condition):** event signature for topic0 =
`keccak256("CallSettled(bytes16,bytes16,address,uint64,uint64,uint64,uint8,bool,uint32,uint64)")`
for BOTH (the `SettlementStatus` enum encodes as `uint8` in the signature).
Field order/types identical. "Alias" is literally true. The 04-04 test suite
adds an explicit assertion of this ABI identity; recorded for WP-06 matrix.

**Requirements unblocked:** SET-08.

**Downstream tasks blocked on this ruling:** 04-04 Task (CallSettled emit +
`vm.expectEmit` tests).

**Recommended/ruled resolution:** research lead CONFIRMED; single emission of
`IPactSettler.CallSettled`; ABI-identity assertion added.

---

## E4 — CallRecord -> event-as-truth — RULED: CONFIRM lead (source-verified)

**Decision:** Replace the Solana `CallRecord` PDA with the `CallSettled` event
+ a `mapping(bytes16=>bool)` dedup as the only persisted per-call state, and
port the byte-level `05` assertions to `vm.expectEmit`.

**Captain ruling (verbatim):**

> E4 = CONFIRM lead: Solana CallRecord PDA -> EVM CallSettled event-as-truth +
> dedup mapping(bytes16=>bool) as the only persisted per-call state; port the
> cr[2]/readU64(cr,80)/readU64(cr,88) byte assertions to vm.expectEmit on
> CallSettled.{status,refund,actualRefund} (§4#3/§4#2). MUST-VERIFY before
> implementing: in settle_batch.rs the CallRecord write at :504-522 runs for
> EVERY processed event INCLUDING DelegateFailed (Solana writes CallRecord
> with the DelegateFailed status — the call_id is consumed, not retryable).
> Confirm the exact Solana behavior from source and mirror it: the dedup
> mapping is set for every call that reaches record-write in Solana INCLUDING
> DelegateFailed, and CallSettled is emitted per call with the final status.
> If settle_batch.rs shows DelegateFailed skips the CallRecord write, mirror
> THAT instead — STOP-AND-ASK if ambiguous, do not guess on this parity point.

**MUST-VERIFY result (resolved from source — NOT ambiguous, no STOP-AND-ASK):**
`settle_batch.rs` confirms DelegateFailed CONSUMES the call_id:
- `:194-196` dedup check: `if !call_record_acct.is_data_empty() { return
  Err(DuplicateCallId) }`.
- `:243-247` comment (verbatim intent): "Allocate CallRecord PDA up front so a
  replay of the same call_id hits `DuplicateCallId` even when the original
  event was settled with a non-Settled status (DelegateFailed, PoolDepleted,
  etc)."
- `:255-262` `create_account(...)` — CallRecord PDA created (now non-empty)
  BEFORE the delegate pre-flight.
- `:332-355` on `!premium_in_ok`: `status = DelegateFailed`; CallRecord WRITTEN
  (`:336-352`); `continue`.
Therefore the EVM mirror is unambiguous: set `_settledCallIds[callId] = true`
BEFORE the premium-in try/catch (so DelegateFailed also dedups / is not
retryable), and emit exactly one `CallSettled` per call with the final status
(Settled or DelegateFailed). Plans already encode this (04-03 sets the dedup
sentinel before the try/catch — 04-03 acceptance line 282).

**Requirements unblocked:** SET-06, SET-08 (and SET-04 dedup parity).

**Downstream tasks blocked on this ruling:** 04-03 Task 2 (dedup-before-
premium-in), 04-04 Task (CallSettled emit + `vm.expectEmit` ports of the
`cr[2]`/`readU64(cr,80)`/`readU64(cr,88)` assertions).

**Recommended/ruled resolution:** research lead CONFIRMED; MUST-VERIFY
RESOLVED from source (DelegateFailed consumes the call_id; mirror exactly).

---

## Config flag — Nyquist / security gates (captain direction, verbatim)

> CONFIG FLAG (Nyquist/security gates): keep DISABLED for WP-04 — the ported
> LiteSVM oracle + strict TDD IS the validation contract (matches the
> methodology that landed WP-02/03 clean); generic Nyquist/threat-model
> ceremony does not improve parity fidelity here. EXPLICIT DIRECTION: WP-05
> (settler hardening) SHOULD enable a settlement threat-model/adversarial
> pass, and WP-06's fuzz/gas suite covers statistical adequacy — record this
> so it is not lost.

Recorded: WP-05 enables a settlement threat-model/adversarial pass; WP-06
fuzz/gas covers statistical adequacy. (Also noted in STATE.md.)

---

## Reporting protocol change (captain direction, verbatim)

> REPORTING CHANGE (relay is misrouting crew->captain reports into sibling
> crew panes): from now on, write every gate/status report to a deterministic
> file .planning/phases/04-pactsettler-happy-path/04-REPORT-<gate>.md AND also
> send the cockpit runtime notice. I pull reports from those files; do not
> rely on the relay reaching me.

GATE A outcome → `.planning/phases/04-pactsettler-happy-path/04-REPORT-gateA.md`;
GATE B → `.../04-REPORT-gateB.md`. Plus a short `cockpit runtime send
pact-network` notice each time.

---

## Proceed directive (captain, verbatim)

> PROCEED: finalize 04-GATE-A-DECISIONS.md with these rulings, then execute
> plans 02->04 via /gsd:execute-phase (TDD red-before-green, file-scoped
> commits, Solana source authority, STOP-AND-ASK on any parity ambiguity).
> Next captain gate = GATE B (after impl + forge build && forge test green,
> before any push/PR). Write the Gate B report to
> .planning/phases/04-pactsettler-happy-path/04-REPORT-gateB.md. Go.
