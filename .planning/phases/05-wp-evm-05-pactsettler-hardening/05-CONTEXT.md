# Phase 5: WP-EVM-05 PactSettler Hardening - Context

**Gathered:** 2026-05-18
**Status:** Ready for planning
**Source:** Locked port artifacts (handoff WP-EVM-04 OUTCOMES §a-f + design spec
§3/§4/§6/§8 + impl plan + WP-04 shipped code). This is a PORT, not a redesign.
NOTHING here is open for re-derivation by the researcher/planner — the rulings
below are settled law. The ONLY OPEN items are the explicitly-labelled GATE A
parity decisions **P1** and **P3**, which the captain rules; the planner records
them AS decisions, it does NOT silently resolve them. STOP-AND-ASK on any
source-vs-sketch conflict (this discipline caught 5 defects in WP-02/03/04).

<domain>
## Phase Boundary

Harden `PactSettler` by filling the FOUR additive WP-05 seams WP-04 left clean,
as a bit-identical behavioral port of
`packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs`
(+ `pause_protocol.rs` / `pause_endpoint.rs`). **Do NOT rewrite WP-04** — the
seams are clean insertion points; the WP-04 per-event shape, the LOCKED
guard-precedence, and the 90/90 forge regression MUST be preserved.

**IN scope (WP-EVM-05) — the 4 seams (handoff §d, anchors authoritative):**
1. **`ExposureCapClamped`** (SET-10) — inside
   `PactRegistry.recordCallAndCapAccrual`, BETWEEN the WP-04 period reset
   (`PactRegistry.sol:260-263`) and the `currentPeriodRefunds` accrual
   (`:274-275`); the exact insertion is the comment at
   `PactRegistry.sol:265-271`. Ports `settle_batch.rs:400-408`:
   `capRemaining = exposureCapPerHour.saturatingSub(currentPeriodRefunds);
   if (payableRefund > capRemaining) { payableRefund = capRemaining; <clamp> }`.
   `currentPeriodRefunds` accrues the CLAMPED (post-cap) amount (`:409-414`,
   already WP-04 `:274-275` using the returned value).
2. **`PoolDepleted`** (SET-09) — the EMPTY `if (ps.currentBalance <
   payableRefund) {}` block in `PactSettler._settleSuccess`
   (`PactSettler.sol:200-205`). WP-05 sets `status = PoolDepleted;
   actualRefund = 0` there; the populated `else` (payout + debitForRefund)
   stays. Ports `settle_batch.rs:462-469`.
3. **Pause kill-switches** (SET-11) — protocol-paused fast-revert PRE-loop
   (before ANY per-event work or transfer; ports `settle_batch.rs:99-115` via
   `registry.protocolPaused()`), and per-event `EndpointPaused`
   (`settle_batch.rs:209`, slots into the LOCKED precedence per §(c) — see
   D-LOCK-PREC). Not present in WP-04.
4. **`BatchTooLarge`** (SET-12) — `events.length > MAX_BATCH_SIZE (50)`
   pre-loop edge. Ports `settle_batch.rs:132-135`. Not present in WP-04.

Plus the deferred test ports (handoff §e): the 4 clamp/kill-switch tests in
`05-settle-batch.test.ts` + full ports of `06-pause.test.ts`,
`07-exposure-cap.test.ts`, `10-pause-protocol.test.ts`,
`09-auth-pda.test.ts` (→ `SETTLER_ROLE`/authority model).

**OUT of scope (do NOT touch):**
- The WP-04 happy-path loop, the LOCKED guard precedence, the E1 hook
  ordering, the E1/E2/E3/E4 resolutions — all settled law (handoff §b#1-8,
  WP-04 OUTCOMES §b/§c). WP-05 is PURE ADDITION at the 4 seams.
- The hourly rolling-window PERIOD RESET — ALREADY WP-04
  (`PactRegistry.sol:260-263`). WP-05 adds ONLY the cap-clamp DECISION at the
  seam; it does NOT re-implement the reset.
- WP-06 (TS client, fuzz/gas, parity matrix, formal spec-defect corrections),
  WP-07 (deploy). No `git push` / no PR #204 comment until captain GATE B.
</domain>

<decisions>
## Implementation Decisions

### LOCKED rulings — settled law (handoff §b/§c + WP-04 OUTCOMES; do NOT re-litigate)

- **D-LOCK-1:** Solana `settle_batch.rs` / `pause_protocol.rs` /
  `pause_endpoint.rs` are the sole parity authority. Where the design spec,
  impl plan, scaffold comments, or this file's prose conflict with the Rust
  source, the Rust source wins. Plan/spec code blocks are non-authoritative
  sketches.
- **D-LOCK-2:** Strict TDD — write the failing Foundry test, run it, confirm
  RED, implement, run, confirm GREEN. Never skip RED. Ported LiteSVM
  scenarios + source-enforced invariants ARE the validation contract.
- **D-LOCK-3:** Divergence ledger (spec §4) is closed. Relevant here:
  §4#1 ERC-20 `transferFrom`+try/catch == `DelegateFailed`; §4#2 single
  contract + `mapping(bytes16 slug => …)` (NO per-endpoint PDAs); §4#3
  first-class `event` is the indexer truth source (NO `CallRecord` — WP-04
  E4); §4#5 OZ `AccessControl` `SETTLER_ROLE`; §4#6 the 3 Solana
  `initialize_*` collapse into `PactRegistry` (so the protocol-paused state
  lives on `PactRegistry`, read via `protocolPaused()`).
- **D-LOCK-4:** WP-02/03 rulings §(b)#1-7 + ruling #8 (D1-scope refinement:
  WP-04+ MAY add SETTLER_ROLE-gated writers where spec §6 places
  `EndpointConfig` state — the E1 hook is sanctioned) stand. WP-04 E1-E4
  resolutions stand (WP-04 OUTCOMES §b).
- **D-LOCK-5:** PORT vs N-A rule (handoff §c). PORT every scenario whose
  behavior survives the §4 ledger. Mark N-A-ON-EVM only for genuine
  Solana-platform mechanics (PDA derivation / `InvalidSeeds`,
  `AccountAlreadyInitialized`, account-owner / signer / rent /
  `system_program` checks, byte-offset/layout asserts, SPL-mint constant
  checks). Each N-A gets a one-line rationale for the WP-06 parity matrix;
  add a source-enforced invariant test where the behavior survives.
- **D-LOCK-6:** Conventions — no emojis anywhere; conventional commits;
  `pnpm`+`forge` never `npm`; file-scoped commits (NO `git add -A`/`-a`),
  one logical change per commit; NO push / NO PR #204 comment until captain
  GATE B. Working tree stays clean (only `?? .claude/pr-reviews/` expected;
  if `CLAUDE.md` shows ` M` or `.claude/skills/pact/` appears, STOP and
  report — contamination incident #5; never run a `pact` skill installer /
  `pact --help`).
- **D-LOCK-PREC (handoff §c — LOCKED guard precedence, WP-05 MUST preserve):**
  Per-event order in `PactSettler.settleBatch`, bit-identical to
  `settle_batch.rs` and pinned by
  `test_DuplicateCallIdPrecedesRecipientCoverageMismatch`:
  `guards (InvalidTimestamp :158 / PremiumTooSmall :161 /
  FeeRecipientArrayTooLong :164)` → **`DuplicateCallId` dedup READ**
  (`settle_batch.rs:194`, `PactSettler.sol:84`) → **`EndpointPaused`**
  (`settle_batch.rs:209` — WP-05 INSERTS HERE, additively, between the dedup
  READ and the next check) → **`RecipientCoverageMismatch`**
  (`settle_batch.rs:213`, `PactSettler.sol:89-91`) → **dedup SET**
  (`PactSettler.sol:98`) → **premium-in** (`PactSettler.sol:106`). WP-05's
  `EndpointPaused` is the ONLY new per-event precedence slot and it is
  additive — no WP-04 reordering.

### LOCKED clamp/kill-switch invariants (re-derived from source 2026-05-18)

- **D-LOCK-CLAMP-ORDER:** Verified from `settle_batch.rs` EXECUTION order
  (the parity authority over spec §3 wording):
  1. Exposure-cap clamp executes FIRST, at `:400-408`, inside the ep mutation
     block (EVM: inside `PactRegistry.recordCallAndCapAccrual`). It clamps
     `intended_refund_after_cap` to `cap_remaining` and sets the
     ExposureCapClamped intent. `current_period_refunds += <clamped amount>`
     (`:409-414`) accrues the post-cap amount and is **NOT rolled back** if
     PoolDepleted later fires (Solana never rolls it back — exposure budget
     is consumed by the cap-clamped INTENDED amount even when the pool can't
     pay it; the EVM port MUST replicate this no-rollback).
  2. Pool-balance check executes SECOND, at `:462-469` (EVM: in
     `PactSettler._settleSuccess`), against the ALREADY cap-clamped amount.
     `status = PoolDepleted` at `:468` is set AFTER `:407`, so **PoolDepleted
     OVERWRITES ExposureCapClamped** when both fire. This is the meaning of
     spec §3 "clamped first by pool balance (PoolDepleted) then by the hourly
     exposure cap" and handoff §(e) "pool-balance THEN exposure cap" — it
     describes FINAL-STATUS PRECEDENCE (PoolDepleted wins), not code order.
     Code order is cap-clamp-then-pool-check; status precedence is
     PoolDepleted > ExposureCapClamped > Settled.
- **D-LOCK-PROTO-PAUSE:** Protocol-paused is a PRE-loop fast-revert
  (`settle_batch.rs:105-115`) — before ANY per-event work or transfer. EVM:
  `if (registry.protocolPaused()) revert ProtocolPaused();` as the FIRST
  statement in the `settleBatch` body, before the `BatchTooLarge` check and
  the loop. `pause_protocol.rs` / `pause_endpoint.rs` just set a flag
  (`state.paused = data[0]`); `PactRegistry.pauseProtocol/pauseEndpoint`
  already do this (WP-02). WP-05 adds only the SETTLE-SIDE enforcement.
- **D-LOCK-BATCH:** `event_count > MAX_BATCH_SIZE` → `BatchTooLarge`
  (`settle_batch.rs:132-135`), strictly greater (50 OK, 51 rejects),
  pre-loop, after the role/protocol-paused gates. EVM:
  `if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();`.
- **D-LOCK-EXPCAP-NA:** `ExposureCapExceeded` (`error.rs` 6002,
  `PactErrors.sol:24`) is N-A-on-EVM in the settle path: `settle_batch.rs`
  CLAMPS the cap (sets `status = ExposureCapClamped`); it NEVER reverts an
  "exceeded" error. One-line WP-06 matrix rationale: "no settle_batch trigger
  — the cap clamps to a status, it does not reject."

### OPEN — GATE A parity decisions (captain rules; planner records, does NOT resolve)

- **P1 — `ExposureCapClamped` status conveyance across the E1 split.**
  The E1 ruling (WP-04, LOCKED) splits the ep mutation into
  `PactRegistry.recordCallAndCapAccrual` (returns `uint64 payableRefund`)
  and the `PactSettler._settleSuccess` call site, which handoff §(d) seam #1
  pins as **unchanged** ("WP-05 adjusts the returned `payableRefund`; the
  `PactSettler` call site is unchanged"). The Solana `status =
  ExposureCapClamped` is set inside the same block that clamps the amount
  (`:407`), but on EVM the `SettlementStatus` enum local lives in
  `PactSettler`, not `PactRegistry`. Lead resolution (seam-forced, parity-
  exact): `PactSettler._settleSuccess` INFERS the clamp by comparing the
  returned `payableRefund` against the `intendedRefundAfterCap` it passed in
  — `payableRefund < intendedRefundAfterCap` ⟺ Solana's `intended >
  cap_remaining` (provably equivalent: clamp returns `cap_remaining` iff
  `intended > cap_remaining`, else returns `intended` unchanged; the `==`
  boundary is correctly "not clamped" in both). When inferred, set
  `status = ExposureCapClamped` BEFORE the pool-balance check so a later
  PoolDepleted can overwrite it (D-LOCK-CLAMP-ORDER). `recordCallAndCapAccrual`
  accrues `currentPeriodRefunds` by the clamped amount and is NOT rolled
  back on a subsequent PoolDepleted. **Captain ratifies** the inference
  mechanism + no-rollback + precedence (analogous to WP-04 E1-E4 — do NOT
  silently implement; do NOT change the seam-pinned call-site signature).
- **P3 — protocol-paused vs `onlyRole(SETTLER_ROLE)` modifier-order
  divergence.** `settleBatch` is LOCKED `onlyRole(SETTLER_ROLE)` (WP-04 E2).
  Solidity modifiers run BEFORE the function body, so an unauthorized caller
  reverts `AccessControlUnauthorizedAccount` BEFORE the body's
  protocol-paused check. Solana's order is: weak `is_signer`
  (`:95`, MissingRequiredSignature) → protocol-paused (`:105-115`,
  ProtocolPaused) → full settler-identity `sa.signer == settler_signer`
  (`:117-130`, UnauthorizedSettler) → BatchTooLarge. So for the corner
  "caller lacks SETTLER_ROLE AND protocol is paused", Solana returns
  `ProtocolPaused` but EVM returns the AccessControl error. For the only
  operationally-real caller (an authorized settler), BOTH return
  `ProtocolPaused` identically. Lead resolution: accept this as an
  **OPTIMIZED-DIVERGENCE** (OZ `AccessControl` idiom; restructuring to an
  in-body `_checkRole` after the pause check would REWRITE the WP-04
  seam-pinned `settleBatch` signature/shape, which is forbidden), document it
  in the WP-06 parity matrix, and PORT the parity-relevant path (authorized
  settler + paused → `ProtocolPaused`; resume after unpause). **Captain
  rules** OPTIMIZED-DIVERGENCE vs an alternative (note: alternative requires
  WP-04 rewrite — flagged as out-of-bounds).

### PORT vs N-A split for the deferred test ports (GATE A — researcher refines)

| Source test | Scenario | Disposition |
|---|---|---|
| `05:442` | pool depleted → `PoolDepleted`, refund skipped | PORT (seam #2); `cr[2]==2` byte-assert → `vm.expectEmit CallSettled.status` (WP-04 E4 pattern) |
| `05:485` | exposure cap clamps → `ExposureCapClamped`, partial actual_refund | PORT (seam #1 + P1 inference); byte-asserts → `expectEmit` |
| `05:529` | rejects `ProtocolPaused` when paused=1 | PORT (seam #3 pre-loop fast-revert) |
| `05:595` | resumes after pause → unpause | PORT (seam #3; pause then unpause then settle succeeds) |
| `06:12/34` | pause_endpoint sets / unsets flag | PORT registry-side IF not already covered by WP-02 `PactRegistry.t.sol`; the WP-05 substance = the SETTLE-SIDE `EndpointPaused` per-event revert (D-LOCK-PREC slot). Researcher dedupes vs WP-02. |
| `06:55` | pause_endpoint rejected for non-authority | PORT (`onlyAuthority`→`UnauthorizedAuthority`) IF not already WP-02-covered |
| `07:25` | refund clamped to cap_remaining, marked `ExposureCapClamped` | PORT (seam #1 + P1) |
| `07:81` | exposure cap resets after 1 hour | PORT — assert the WP-04 period reset end-to-end through `settleBatch` (do NOT re-implement reset); use `vm.warp` |
| `09:47/78` | pause_endpoint rejects fake / wrong-owner ProtocolConfig | N-A-ON-EVM (PDA-address / account-owner spoofing — §4#2/#6). Surviving invariant: `pauseEndpoint` is `onlyAuthority` (source-enforced test). 1-line matrix rationale. |
| `09:144` | update_endpoint_config rejects fake ProtocolConfig | N-A-ON-EVM (same). Surviving: `updateEndpointConfig` `onlyAuthority`. |
| `09:172` | update_fee_recipients rejects fake Treasury | N-A-ON-EVM (Treasury PDA spoof; EVM `treasuryVault` is an immutable addr). Surviving: `updateFeeRecipients` `onlyAuthority`. |
| `10:28` | pause_protocol(1)/(0) toggles paused | PORT — registry toggle IF not WP-02-covered; WP-05 substance = SETTLE-SIDE `ProtocolPaused` revert + resume (seam #3) |
| `10:72` | pause_protocol rejects non-authority | PORT (`onlyAuthority`) IF not WP-02-covered |
| `10:94/128` | pause_protocol rejects fake / wrong-owner ProtocolConfig | N-A-ON-EVM (PDA / owner spoof). Surviving: `pauseProtocol` `onlyAuthority`. |
| (no Solana test) | `BatchTooLarge` edge | PORT as a source-enforced invariant test (D-LOCK-5): 51 events → `BatchTooLarge`, 50 → OK |

The `09-auth-pda` handoff note "auth → `SETTLER_ROLE` model": the surviving
parity for settle-side auth is `settleBatch` `onlyRole(SETTLER_ROLE)` —
unauthorized caller reverts (assert via `vm.expectRevert` AccessControl). The
registry mutators stay `onlyAuthority` (WP-02). Every PDA/owner-spoof scenario
becomes one N-A matrix line + the surviving authority-revert invariant.

### Claude's Discretion (within parity)
- Internal layout of the WP-05 inserts (helper extraction, local naming) —
  provided economic outputs, mutation ORDER, and the LOCKED precedence match
  `settle_batch.rs` exactly and the WP-04 90/90 regression stays green.
- Foundry test-util reuse from the WP-04 `PactSettler.t.sol` harness.
</decisions>

<specifics>
## Specific Ideas — exact source anchors (authority; re-derive in full)

`settle_batch.rs` (THE authority):
- `:99-115` protocol-paused fast-revert (PRE-loop) → seam #3 protocol side.
- `:132-135` `event_count > MAX_BATCH_SIZE` → `BatchTooLarge` (seam #4).
- `:194` dedup READ → `:209` `ep.paused != 0 → EndpointPaused` (seam #3
  endpoint side, D-LOCK-PREC slot) → `:213` `RecipientCoverageMismatch`.
- `:380` `intended_refund_after_cap = refund_lamports`.
- `:400-408` cap clamp: `cap_remaining = exposure_cap_per_hour.saturating_sub(
  current_period_refunds); if intended > cap_remaining { intended =
  cap_remaining; status = ExposureCapClamped }` (seam #1).
- `:409-414` `if intended > 0 { current_period_refunds += intended }` (already
  WP-04 `:274-275`; uses the post-cap amount).
- `:462-469` `if pool_balance < intended { status = PoolDepleted;
  actual_refund = 0 }` else transfer (seam #2; the populated `else` is WP-04).
- `:493-499` `ep.total_refunds += actual_refund` — already WP-04
  `recordRefundPaid`, only called when `actualRefund > 0`.

`SettlementStatus { Settled=0, DelegateFailed=1, PoolDepleted=2,
ExposureCapClamped=3 }`. WP-04 produced 0/1; WP-05 adds 2/3.

EVM seams (handoff §d, post-`4cb699d` line numbers; Rust anchors authoritative):
- `PactRegistry.sol:265-271` — comment seam for cap clamp (between `:260-263`
  reset and `:274-275` accrual). WP-05 makes `payableRefund` the clamped
  value; returned to the unchanged `_settleSuccess` call site.
- `PactSettler.sol:200-205` — empty `if (ps.currentBalance < payableRefund)`
  block for `PoolDepleted`.
- `PactSettler.settleBatch` body head — insert `ProtocolPaused` then
  `BatchTooLarge` pre-loop; insert `EndpointPaused` at the D-LOCK-PREC slot.
</specifics>

<canonical_refs>
## Canonical References
**Downstream agents MUST read these before researching/planning/implementing.**

### Parity authority (Solana — source of truth)
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs` — THE WP-05 authority (clamps, kill-switch, batch edge).
- `…/src/instructions/pause_protocol.rs`, `…/pause_endpoint.rs` — flag setters (already mirrored in `PactRegistry`; WP-05 adds settle-side enforcement).
- `…/src/{state.rs,constants.rs,error.rs}` — `EndpointConfig`/`CoveragePool` widths, `MAX_BATCH_SIZE=50`, error trigger conditions.

### Parity oracle (port per the split table)
- `…/tests/05-settle-batch.test.ts` — the 4 deferred clamp/kill scenarios (`:442,:485,:529,:595`).
- `…/tests/06-pause.test.ts`, `07-exposure-cap.test.ts`, `09-auth-pda.test.ts`, `10-pause-protocol.test.ts`.
- `…/tests/helpers.ts` — builders/defaults to mirror as Foundry utils.

### EVM port — current state (compose/extend at the seams; do NOT reopen)
- `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` — WP-04 shipped; seam at `:200-205`; `settleBatch` body head for pre-loop inserts.
- `packages/program-evm/protocol-evm-v1/src/PactRegistry.sol` — WP-04 shipped; cap-clamp seam comment `:265-271`; `protocolPaused()` getter; `EndpointConfig.paused`.
- `packages/program-evm/protocol-evm-v1/src/interfaces/{IPactSettler,IPactRegistry,IPactPool}.sol` — `SettlementStatus{…,PoolDepleted,ExposureCapClamped}`, `protocolPaused()`, `EndpointConfig.paused` confirmed present.
- `packages/program-evm/protocol-evm-v1/src/{ArcConfig.sol,errors/PactErrors.sol}` — `MAX_BATCH_SIZE`; `ProtocolPaused/EndpointPaused/PoolDepleted/BatchTooLarge` errors present.
- `packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol` + `Deployment.t.sol` — WP-04 harness/role-grant patterns to extend; full WP-02/03/04 suite (90/90) MUST stay green.

### Locked process docs (settled law — do NOT re-derive)
- `docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md` — §b#1-8, §c methodology, §d WP-05 seams, §e WP-05 scope, WP-04 OUTCOMES §a-f.
- `docs/superpowers/specs/2026-05-15-arc-parity-port-design.md` §3/§4/§6/§8.
- `docs/superpowers/plans/2026-05-15-arc-parity-port.md`.
- `.planning/phases/04-pactsettler-happy-path/04-GATE-A-DECISIONS.md` — canonical E1-E4 record (WP-05 builds on these verbatim).
- `CLAUDE.md` — conventions (pnpm, no emojis, conventional commits).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PactRegistry.recordCallAndCapAccrual` already does the period reset +
  `currentPeriodRefunds` accrual + returns `payableRefund`; WP-05 inserts ONLY
  the cap-clamp between `:260-263` and `:274-275` (seam comment `:265-271`).
- `PactSettler._settleSuccess` already has the `if/else` PoolDepleted skeleton
  (`:198-211`); WP-05 fills the empty `if`.
- `PactRegistry.{pauseProtocol,pauseEndpoint}` + `protocolPaused()` +
  `EndpointConfig.paused` all shipped (WP-02); WP-05 reads them settle-side.
- WP-04 `PactSettler.t.sol` harness (two-layer SETTLER_ROLE grant, MockUSDC,
  `vm.prank`/`vm.warp` discipline) — extend, don't rebuild.

### Established Patterns
- `mapping(bytes16 => …)` slug keying; custom errors (no revert strings);
  `_ckAdd`/`_ckSub` → `ArithmeticOverflow`; OZ `AccessControl`; `vm.expectEmit`
  for `CallSettled` status/refund assertions (WP-04 E4 — reuse for cr[] bytes).

### Integration Points
- `PactSettler.settleBatch` → `registry.protocolPaused()` (pre-loop),
  `registry.getEndpoint().paused` (per-event), `recordCallAndCapAccrual`
  (cap-clamp via return value, call site unchanged), `_settleSuccess`
  pool-balance check (PoolDepleted).
</code_context>

<deferred>
## Deferred Ideas
- WP-06: TS client, fuzz/gas suite, parity-matrix doc (consumes the
  N-A rationales + P1/P3 dispositions recorded here), formal spec-defect
  corrections (handoff §d).
- WP-07: deploy/verify.
- Config: a settlement threat-model / adversarial pass MAY be enabled for
  WP-05 (WP-04 OUTCOMES §e); flag the decision in the GATE A report. Nyquist
  stays off (ported LiteSVM oracle + strict TDD is the contract).
</deferred>

---

*Phase: 05-wp-evm-05-pactsettler-hardening*
*Context bootstrapped 2026-05-18 by the WP-EVM-05 crew (fresh resume). No
discuss-phase: the design is locked law per the handoff WP-04 OUTCOMES;
re-derivation is forbidden. Researcher/planner consume this verbatim; OPEN
items P1/P3 are captain-ruled at GATE A, not silently resolved.*
