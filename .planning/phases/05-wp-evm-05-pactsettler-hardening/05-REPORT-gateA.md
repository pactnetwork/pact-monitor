# WP-EVM-05 — GATE A Report (request — captain ruling needed)

**Date:** 2026-05-18
**Crew:** WP-EVM-05 (fresh resume; continues `feat/arc-protocol-v1`)
**Status:** GATE A — plan-phase pipeline COMPLETE and re-verified PASSED.
AWAITING captain ruling on TWO open parity decisions (P1, P3) + an
adversarial-pass config decision, then plan approval. NO Solidity written.
NO push. NO PR #204 comment. Working tree clean (only `?? .claude/pr-reviews/`;
CLAUDE.md unmodified; no `.claude/skills/pact/` — no contamination).

## What happened (GSD plan-phase per spec §8)

1. STEP 0 done: read the handoff end to end (WP-04 OUTCOMES LOCKED §a-f),
   design spec §3/§4/§6/§8, impl plan, `settle_batch.rs` (full),
   `pause_protocol.rs`, `pause_endpoint.rs`, and the shipped WP-04
   `PactSettler.sol` / `PactRegistry.sol` seams.
2. Authored `05-CONTEXT.md` from locked law (mirrors how `04-CONTEXT.md` was
   bootstrapped): D-LOCK-* settled rulings + the 4 seams with exact file:line
   anchors + the LOCKED guard precedence + the LOCKED clamp/status precedence
   + the two OPEN GATE-A decisions P1/P3 + the PORT/N-A split table. No
   discuss-phase: re-derivation is forbidden by the handoff.
3. gsd-phase-researcher (`05-RESEARCH.md`, committed `97576bc`): re-derived
   the clamp/kill-switch/batch control flow from `settle_batch.rs` in full.
   Confirmed D-LOCK-PREC, D-LOCK-CLAMP-ORDER, the pre-loop order, and the
   WP-02 test-coverage dedup. NO source-vs-context conflicts ([PARITY-CONFLICT]
   count = 0). HIGH confidence.
4. gsd-planner: 6 plans (05-01..05-06). gsd-plan-checker found ONE blocker
   (Dimension 3 — dependency correctness: all PactSettler.sol-editing plans
   could run concurrently under the config's enabled parallelization). Fixed
   surgically (frontmatter only — serial chain) and RE-VERIFIED:
   `## VERIFICATION PASSED`. All other dimensions passed first time.

## DECISION 1 — P1: ExposureCapClamped status conveyance across the E1 split

Status: OPEN. Captain rules (analogous to WP-04 E1-E4). The planner RECORDED
it; it did NOT resolve it. Verbatim framing from `05-RESEARCH.md`:

The structural problem: in Solana, `status = ExposureCapClamped`
(`settle_batch.rs:407`) is set inside the same ep-borrow block that performs
the clamp. On EVM the WP-04 E1 split (LOCKED) moved the ep mutation into
`PactRegistry.recordCallAndCapAccrual`, which returns only
`uint64 payableRefund`; the `SettlementStatus` local lives in
`PactSettler._settleSuccess`, and handoff §d seam #1 PINS that call site
UNCHANGED. So the clamp status cannot be returned without changing the
seam-pinned signature.

Lead resolution (seam-forced, NOT yet captain-ratified): `_settleSuccess`
INFERS the clamp by comparing the returned `payableRefund` against the
`intendedRefundAfterCap` it passed in. `payableRefund < intendedRefundAfterCap`
is provably equivalent to Solana's `intended > cap_remaining`: Solana returns
`cap_remaining` iff it clamped (`intended > cap_remaining`), else returns
`intended` unchanged; the `==` boundary is "not clamped" in BOTH (Solana
condition is `>` not `>=`); and the non-breach `intended == 0` case can never
clamp in either (Solana guards the block with `if intended_refund > 0` at
`:400`, and `0 < 0` is false). When inferred, set
`status = ExposureCapClamped` BEFORE the pool-balance check so a subsequent
PoolDepleted OVERWRITES it (D-LOCK-CLAMP-ORDER — Solana sets PoolDepleted at
`:468`, after `:407`). `recordCallAndCapAccrual` accrues `currentPeriodRefunds`
by the clamped amount and that accrual is NOT rolled back if PoolDepleted then
fires (Solana never rolls it back; `recordRefundPaid` is only called when
`actualRefund > 0`, so no rollback path exists or is needed — parity exact).

Captain decision required: ratify (a) the inference predicate
`payableRefund < intendedRefundAfterCap`, (b) the no-rollback invariant, and
(c) setting ExposureCapClamped before the pool-balance check so PoolDepleted
overwrites. Constraint: do NOT change the seam-pinned `recordCallAndCapAccrual`
signature (`PactRegistry.sol:244-249`); do NOT add a bool/enum return.

## DECISION 2 — P3: protocol-paused vs onlyRole(SETTLER_ROLE) modifier order

Status: OPEN. Captain rules. Verbatim framing from `05-RESEARCH.md`:

Solidity modifiers execute before the function body. `settleBatch` is
`onlyRole(SETTLER_ROLE)` (WP-04 E2, LOCKED). Solana's order is: weak
`is_signer` (`:95`, MissingRequiredSignature) then `ProtocolPaused`
(`:99-115`) then the full settler-identity check
(`:117-130`, UnauthorizedSettler) then BatchTooLarge (`:132-135`). So for the
corner "caller lacks SETTLER_ROLE AND protocol is paused": Solana returns
`ProtocolPaused`; EVM returns `AccessControlUnauthorizedAccount` (modifier
fires before the body's pause check). For the only operationally-real path
(authorized settler + protocol paused) BOTH chains return `ProtocolPaused` —
identical.

Lead resolution (seam-forced): accept as OPTIMIZED-DIVERGENCE. The
alternative — an in-body `_checkRole` placed after the pause check — requires
rewriting the WP-04 `settleBatch` signature/shape, which is forbidden
(no WP-04 reopen). Document the corner in the WP-06 parity matrix; PORT the
parity-relevant path only (authorized settler + paused → `ProtocolPaused`;
resume after unpause → success).

Captain decision required: ratify OPTIMIZED-DIVERGENCE, or direct the
alternative (note: the alternative is out-of-bounds — it rewrites WP-04).

## DECISION 3 — adversarial pass (config flag, per WP-04 OUTCOMES §e)

WP-04 OUTCOMES §e says WP-05 SHOULD enable a settlement threat-model /
adversarial pass. Recommendation (verbatim from `05-RESEARCH.md`): enable a
BRIEF manual adversarial review scoped to the 4 WP-05 seams only — (1)
cross-agent cap saturation forcing another endpoint's ExposureCapClamped in
the same batch; (2) empty-batch (`events.length == 0`) pause-bypass (Solana
`event_count = 0` is valid, loop never runs; EVM same, pause check fires
pre-loop); (3) reentrancy through `registry.protocolPaused()` / pool hooks on
the PoolDepleted path (PactPool is trusted; `pool.payout` only fires in the
else branch, never on PoolDepleted). NOT a fuzz suite (that is WP-06). Nyquist
stays OFF per config. Captain decision: enable this brief pass (recommended)
or defer it to WP-06.

## PORT vs N-A split for the ported tests (for captain visibility)

Settle-side PORT (the WP-05 substance): `05:442` pool-depleted → PoolDepleted;
`05:485` / `07:25` exposure-cap clamp → ExposureCapClamped (+ P1 inference);
`07:81` hourly window reset asserted end-to-end through settle via `vm.warp`
(reset itself is already WP-04 — only asserted here, not re-implemented);
`05:529` ProtocolPaused when paused=1; `05:595` resume after unpause;
`06` settle-side EndpointPaused per-event revert; BatchTooLarge as a
source-enforced invariant test (51 events revert, 50 OK — no Solana scenario
exists, added per the PORT-vs-N-A rule).

Registry-side already covered by WP-02 `PactRegistry.t.sol` (31 tests) — NOT
duplicated: `06:12/34/55` pause_endpoint set/unset/non-authority;
`10:28/72` pause_protocol toggle/non-authority. WP-05 adds ONLY the
settle-side enforcement.

N-A-ON-EVM (one-line WP-06 parity-matrix rationale each + surviving
authority-invariant already in WP-02): `09:47/78` pause_endpoint fake /
wrong-owner ProtocolConfig; `09:144` update_endpoint_config fake
ProtocolConfig; `09:172` update_fee_recipients fake Treasury;
`10:94/128` pause_protocol fake / wrong-owner ProtocolConfig — all are Solana
PDA-address / account-owner spoofing with no EVM equivalent (§4#2/#6). Also
N-A: `ExposureCapExceeded` error has no settle_batch trigger (the cap clamps
to a status, it never reverts). Solana `cr[]` byte-asserts port to
`vm.expectEmit` on `CallSettled.{status,refund,actualRefund}` (WP-04 E4
pattern).

## Final plan shape (re-verified PASSED — serial chain, GATE-A-gated)

| Plan | Wave | depends_on | Role |
|---|---|---|---|
| 05-01 | 1 | [] | GATE-A decision record — captain rules P1/P3/adversarial; GATES ALL Solidity (chain root) |
| 05-02 | 2 | 05-01 | ProtocolPaused fast-revert (P3) + BatchTooLarge pre-loop. SET-11/12 |
| 05-03 | 3 | 05-02 | Per-event EndpointPaused at the D-LOCK-PREC slot. SET-11 |
| 05-04 | 4 | 05-03 | Exposure-cap clamp + P1 inference + 1h-reset assertion. SET-10 |
| 05-05 | 5 | 05-04 | Pool-depleted clamp + cap/pool precedence + no-rollback. SET-09 |
| 05-06 | 6 | 05-05 | Test-port completion + N-A matrix + full regression + GATE B. SET-09..12 |

Linear chain `05-01→05-02→05-03→05-04→05-05→05-06` (acyclic, single
topological order) — all five Solidity plans mutate `PactSettler.sol`/
`PactSettler.t.sol`, so depends_on serializes them since the config enables
parallelization. Every plan reaches the 05-01 GATE-A root transitively; P1
(05-04) and P3 (05-02) cannot execute until the captain rules. Every impl
task is strict TDD RED-before-GREEN, file-scoped conventional commits,
additive-only (grep-negative criteria block WP-04 edits), and carries the
WP-04 90/90 forge regression as an explicit must_have. SET-09/10/11/12 each
appear in a plan's `requirements` field.

## Locked-law preservation (confirmed by research + plan-check)

D-LOCK-PREC (guard precedence) preserved — EndpointPaused inserts additively
between the dedup READ and RecipientCoverageMismatch;
`test_DuplicateCallIdPrecedesRecipientCoverageMismatch` stays green (asserted
in 05-03). D-LOCK-CLAMP-ORDER preserved — code order cap-clamp then
pool-check; final status precedence PoolDepleted > ExposureCapClamped >
Settled; currentPeriodRefunds accrues the clamped amount, no rollback
(asserted by a combined test in 05-05). Pre-loop order: ProtocolPaused first,
then BatchTooLarge, then loop (05-02). All four seams are PURE ADDITION — no
WP-04 rewrite or reorder.

## What I need from the captain (plan-review verdict)

1. Rule P1 (inference mechanism + no-rollback + precedence; seam signature
   pinned).
2. Rule P3 (OPTIMIZED-DIVERGENCE vs the out-of-bounds alternative).
3. Decide DECISION 3 (enable the brief adversarial pass — recommended — or
   defer to WP-06).
4. Approve the 6-plan shape (or direct changes).

On your ruling I will record it verbatim in `05-GATE-A-DECISIONS.md`
(mirroring `04-GATE-A-DECISIONS.md`), which satisfies plan 05-01, then run
`/gsd:execute-phase` 05-02→05-06. I will STOP-AND-ASK on any parity ambiguity
(Solana source authority), halt at GATE B, write `05-REPORT-gateB.md` + a
cockpit notice, and WAIT — no push / no PR #204 comment until you approve
GATE B. NO Solidity will be written before your GATE A approval.
