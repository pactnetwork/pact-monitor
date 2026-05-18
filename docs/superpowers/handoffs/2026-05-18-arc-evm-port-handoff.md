# Arc EVM Parity Port — Crew Handoff (WP-EVM-04 onward)

**Date:** 2026-05-18
**Purpose:** Resume the Arc EVM parity port at **WP-EVM-04** with a FRESH crew,
WITHOUT re-deriving any prior decision. WP-EVM-02 (registry/fee/errors/events)
and WP-EVM-03 (pool) are complete, pushed, and PR-commented. Read this doc end
to end before touching anything.

---

## (a) Branch, PR, commit lineage

- **Branch:** `feat/arc-protocol-v1` (same branch for the whole port — do NOT
  create a new branch/worktree).
- **PR:** #204 (`solder-build/pact-monitor` remote;
  `pactnetwork/pact-monitor` GitHub). All WP completion summaries are PR #204
  comments.
- **Working dir for forge:** `packages/program-evm/protocol-evm-v1/`
  (Foundry; `forge` + `pnpm` repo, never `npm`).
- **Commit lineage (oldest → newest):**
  - `82c38f7` design spec · `c13066d` impl plan (WP-02 detailed, WP-03..06 scoped)
  - `237a99c` predecessor / WP-EVM-01 scaffold base on branch
  - **WP-EVM-02:** `62ae70b` (toolchain: OZ+forge-std, MockUSDC) ·
    `8a85e02` (constants) · `74a6ddf` (30 PactError custom errors) ·
    `531995a` (PactEvents) · `d6c8460` (FeeValidation: fee.rs port) ·
    `35565c6` (§4#7 affiliate non-zero guard) ·
    `24ccc42` (PactRegistry full logic + ported tests)
  - **WP-EVM-03 plan:** `8e8f004` (PactPool detailed plan, authored at turn)
  - **WP-EVM-03:** `8369f8a` (shell) · `c44f7bd` (topUp) ·
    `467c4a0` (balanceOf + scenarios) · `9d25856` (ArithmeticOverflow pin) ·
    `de3f15e` (settler hooks)
- **State:** `forge build` clean; `forge test` **70/70 green**
  (ArcConstants 1, Deployment 4, FeeValidation 15, PactRegistry 31,
  PactPool 19). Everything through `de3f15e` is pushed.

---

## (b) LOCKED parity rulings — DO NOT re-litigate

These were escalated, captain-ruled, and verified. Treat as settled law:

1. **`FeeBpsSumOver10k` is the 30th `PactError`** (`error.rs` 6018), a
   DISTINCT trigger from `FeeBpsExceedsCap` (6017): `fee.rs:83-88` returns
   `FeeBpsSumOver10k` when `sum_bps > ABSOLUTE_FEE_BPS_CAP`, `FeeBpsExceedsCap`
   when `sum_bps > max_total_fee_bps` and for per-entry `bps > cap`. The
   design-spec §3 enumerated list and the impl-plan 29-error list both OMIT
   it — **spec defect**; `error.rs` is the named authority (30 variants).
   Already ported correctly in `src/errors/PactErrors.sol`.
2. **§4 #7 `InvalidAffiliateAta` = OPTIMIZED-DIVERGENCE, NOT N/A.**
   `validate_affiliate_atas` SPL-ATA introspection has no EVM equivalent, but
   the residual invariant ("affiliate destination non-zero") keeps
   `InvalidAffiliateAta` reachable with a narrowed trigger
   (`FeeValidation.sol` final loop). `FeeRecipientInvalidUsdcMint` IS
   genuinely N/A (mint == USDC_DEVNET/MAINNET is a Solana-platform check).
3. **Option B — `FeeValidation.validateDefaultTemplate` is a SEPARATE
   function**, a faithful port of `initialize_protocol_config.rs:84-156`:
   NO substitution, NO post-substitution dup pass, `count == 0` INTENTIONALLY
   allowed (operators may require per-endpoint recipients), plus the extra
   `max_total_fee_bps > ABSOLUTE_FEE_BPS_CAP → FeeBpsExceedsCap` config check.
   Do NOT unify it with `FeeValidation.validate`. Two validators mirror two
   distinct Solana code paths.
4. **`PactRegistry.registerEndpoint` validates fees BEFORE the
   `EndpointAlreadyRegistered` check** (mirrors `register_endpoint.rs` step
   order: parse/validate/substitute/post-sub THEN `is_data_empty`).
5. **`FeeValidation.validate` is used on BOTH register paths**
   (explicit + default-copy). For the default-copy path it re-runs the parse
   loop vs Solana's copy+substitute+post-sub, but this is **provably
   idempotent** on construction-validated defaults (same rules, immutable
   `maxTotalFeeBps`); `count==0` defaults → `MissingTreasuryEntry` at register
   in BOTH. No input diverges.
6. **Pool decisions D1-D6 (WP-EVM-03), all captain-approved:**
   - D1: pool exists ⟺ `registry.isRegistered(slug)` (else
     `EndpointNotFound`); `PactPool` holds an immutable `IPactRegistry` ref;
     NO modification of committed WP-02 `PactRegistry`.
   - D2: `createdAt` set on first `topUp` (Solana sets at register) —
     informational-only divergence; never read by `top_up`/`settle` logic.
   - D3: `topUp` authority-gated — `msg.sender != registry.authority()` →
     `UnauthorizedAuthority`; the funder IS the authority
     (`safeTransferFrom(msg.sender, address(this), amount)`). The plan/spec
     "funder→pool" loose wording was WRONG; resolved to source.
   - D4: settler hooks (`creditPremium`/`debitForFees`/`debitForRefund`/
     `payout`) defined + isolation-tested in WP-03, COMPOSED by WP-04.
   - D5: `PactPool(usdc, registry)` 2-arg ctor; `Deployment.t.sol` updated.
   - D6: `ArithmeticOverflow` is a NAMED error in BOTH directions
     (`_ckAdd` overflow, `_ckSub` underflow) — never a Solidity `Panic`.
     Reachable for `uint64` (unlike the WP-02 `uint32` fee-sum, which was
     provably unreachable and correctly left as no-dead-code).
7. **`updateEndpointConfig`** mechanism divergence: Solana per-field presence
   flags → EVM full typed field set (state parity preserved; callers pass
   current values for unchanged fields).

---

## (c) Methodology — non-negotiable

- **Solana source is the authority over any plan/spec sketch.** Where they
  conflict, the `pact-network-v1-pinocchio` source wins. The plan/spec code
  blocks are non-authoritative sketches.
- **STOP-AND-ASK immediately on ANY parity ambiguity or source-vs-plan
  conflict.** This discipline caught `FeeBpsSumOver10k`, §4#7, Option B, and
  D3. Do not guess on economic/validation logic — it must be bit-identical
  to Solana. Report via `cockpit runtime send pact-network` and WAIT.
- **Strict TDD:** write the failing test, run it, confirm RED, implement,
  run, confirm GREEN. Never skip the red step.
- **File-scoped commits**, conventional-commit messages, one logical change
  per commit. NO `git add -A`/`git add .`/`git commit -a`.
- **Captain gate cadence per WP:** (1) plan-review gate — author the detailed
  WP plan (WP-04/05 via GSD: `/gsd:plan-phase` then `/gsd:execute-phase`,
  per spec §8), report, WAIT for approval BEFORE any Solidity; (2) final
  parity gate — after impl + `forge build && forge test` green, report,
  WAIT, NO push / NO PR comment until approved.
- **PORT vs N/A-on-EVM rule:** PORT every scenario whose behavior survives
  the §4 divergence ledger. Mark N/A-ON-EVM ONLY for genuine Solana-platform
  mechanics: PDA derivation / `InvalidSeeds`, `AccountAlreadyInitialized`,
  `NotEnoughAccountKeys`/signer/rent/`system_program`, byte-offset/layout
  assertions, SPL-mint constant checks. Add source-enforced invariant tests
  even when no LiteSVM scenario exists. Every N/A gets a one-line rationale
  recorded for the WP-06 parity matrix.

---

## (d) WP-EVM-06 spec-defect / divergence log (formal corrections deferred to WP-06)

WP-06 must produce the parity matrix AND formally correct these in the spec:

1. Design-spec §3 enumerated `PactError` list omits `FeeBpsSumOver10k`
   (6018) — add it; `error.rs` has 30 variants.
2. §4 #7 wording "InvalidAffiliateAta unreachable / N-A" is wrong — it is
   OPTIMIZED-DIVERGENCE (zero-address affiliate guard). Only
   `FeeRecipientInvalidUsdcMint` is true N/A.
3. `updateEndpointConfig` per-field-flags → full-typed-set mechanism
   divergence (state parity preserved).
4. D2: `CoveragePool.created_at` set lazily at first `topUp` on EVM
   (informational-only; Solana sets at register).

---

## (e) Conventions / hard constraints

- **No emojis** anywhere (code, UI, commits, comments).
- **Conventional commits** (`feat:`/`fix:`/`test:`/`docs:`/`chore:`).
- **`pnpm` + `forge`**, never `npm`. Forge 1.3.2: `forge install <dep>` (the
  `--no-commit` flag is removed; no-commit is default); `foundry.lock` is
  committed.
- **NO push / NO PR #204 comment until the captain approves that WP's final
  gate.** The captain drives integration.
- **CONTAMINATION INCIDENT (containment #5, 2026-05-18):** a different crew's
  `pact` skill-installer appended a "## Paid API calls" block to `CLAUDE.md`
  and dropped `.claude/skills/pact/`. Both were quarantined to
  `/Users/q3labsadmin/Q3/Solder/_quarantine/2026-05-18-pact-skill-contamination`.
  **NEVER run a `pact` skill installer / `pact --help` skill bootstrap.**
  Keep the working tree clean — only `?? .claude/pr-reviews/` is expected
  (pre-existing, NOT contamination, do not touch it). If `CLAUDE.md` shows
  ` M` or `.claude/skills/pact/` reappears, STOP and report — do not clean
  it yourself.
- Read-before-edit enforced by the harness; use absolute paths in `bash`
  (working dir persists between calls — `cd` once and stay aware).
- GitNexus index staleness reminders fire after each commit; deferring
  re-index across the port is acceptable (Solidity package not in the
  TS/Rust-focused index). Do NOT run `gitnexus analyze` from a worktree.

---

## (f) Remaining work packages

- **WP-EVM-04 — PactSettler happy path** *(NEXT; GSD per spec §8)*.
  `settleBatch` happy path + ported `tests/05-settle-batch.test.ts`. Source
  of truth: `src/instructions/settle_batch.rs` (per-event loop). Use
  `/gsd:plan-phase` then `/gsd:execute-phase` (too complex for one-shot
  bite-sizing — spec §8 explicitly chose GSD). Captain plan-review gate THEN
  final parity gate.
- **WP-EVM-05 — PactSettler hardening** *(GSD)*. Exposure-cap clamp
  (`ExposureCapClamped`), pool-depleted clamp (`PoolDepleted`),
  protocol/endpoint kill switches, batch-limit edges + ported
  `tests/06-pause.test.ts`, `07-exposure-cap.test.ts`,
  `10-pause-protocol.test.ts` (settle side), `09-auth-pda.test.ts`
  (→ `SETTLER_ROLE`).
- **WP-EVM-06 — TS client + consolidated suite + parity matrix.**
  `@pact-network/protocol-evm-v1-client` (pnpm workspace member, viem),
  fuzz/gas suite, live `IERC20(USDC).decimals()==6` assertion, parity-matrix
  doc (per-variant IDENTICAL / OPTIMIZED-DIVERGENCE / N-A-on-EVM), and the
  formal spec corrections from §(d).
- **WP-EVM-07** — deploy script + Arc testnet deploy + arcscan verify
  (deferred; separate cycle; NOT part of the parity effort).

---

## (g) `settle_batch.rs` facts WP-04 starts informed by

(Authoritative re-derivation is WP-04's job from `settle_batch.rs` in full;
this is orientation only.) Per-event loop, in order:

1. **Pre-loop:** protocol `paused` → `ProtocolPaused` BEFORE any per-event
   work or transfer (spec §3 kill-switch). Batch size ≤ `MAX_BATCH_SIZE`
   (50) else `BatchTooLarge`.
2. **Per event:** `MIN_PREMIUM` (100) floor → `PremiumTooSmall`;
   `timestamp > now` → `InvalidTimestamp`; `fee_count_hint != stored count`
   guard; dedup by `call_id` (Solana: non-empty CallRecord PDA → EVM
   `mapping(bytes16 => bool)` → `DuplicateCallId`); endpoint `paused`
   enforced per event.
3. **Premium-in:** `transferFrom(agent, pool, premium)` with try/catch →
   `DelegateFailed` (§4 #1). On success: `cp.current_balance += premium;
   cp.total_premiums += premium` (`settle_batch.rs:360-368` →
   `PactPool.creditPremium`); endpoint stats `ep.total_calls += 1;
   ep.total_premiums += premium` (`:385-388`).
4. **Hourly exposure window:** `ep.current_period_start` /
   `ep.current_period_refunds` rolling 1-hour reset; `saturating_sub`
   remaining cap (`:393-412`). Clamp ordering: **pool balance first
   (`PoolDepleted`) then exposure cap (`ExposureCapClamped`)** (spec §3).
5. **Fee fan-out:** each recipient `premium * bps / 10_000` integer floor
   div; pool keeps residual; `cp.current_balance -= total_fee_paid`
   (`:442-453` → `PactPool.debitForFees` + `payout` egress).
6. **Refund on breach:** clamped (pool then cap);
   `cp.current_balance -= actual_refund; cp.total_refunds += actual_refund`
   (`:481-490` → `PactPool.debitForRefund` + `payout`); `ep.total_refunds
   += actual_refund` (`:496-498`); `ep.total_breaches` on breach.
7. **Status:** `SettlementStatus { Settled=0, DelegateFailed=1,
   PoolDepleted=2, ExposureCapClamped=3 }` emitted per call;
   `emit CallSettled(...)` per call (indexer truth source, §4 #3).
8. **Role gate:** `SETTLER_ROLE` (§4 #5; Solana `SettlementAuthority` PDA
   delegate). `PactPool` already exposes the SETTLER-gated primitives
   (`creditPremium`/`debitForFees`/`debitForRefund`/`payout`) — WP-04
   composes them; grant `SETTLER_ROLE` to the deployed `PactSettler`.

`IPactSettler` scaffold already declares `SettlementEvent`,
`SettlementStatus`, `CallSettled`, `settleBatch` — finalize against
`settle_batch.rs`. WP-04 = happy path (premium-in, fee fan-out, refund,
events, stats); WP-05 = the clamps + kill switches + batch edges.

---

## (h) Source-of-truth file paths

Solana program (parity authority):
`packages/program/programs-pinocchio/pact-network-v1-pinocchio/`
- `src/instructions/settle_batch.rs` — WP-04/05 authority
- `src/instructions/{register_endpoint,update_endpoint_config,update_fee_recipients,pause_endpoint,pause_protocol,top_up_coverage_pool,initialize_protocol_config,initialize_treasury}.rs`
- `src/{state.rs,fee.rs,error.rs,constants.rs}`
- `tests/*.test.ts` (10 LiteSVM files — the parity oracle; WP-04 ports
  `05-settle-batch.test.ts`, WP-05 ports `06/07/10/09`)
- `tests/helpers.ts` (builders, defaults, `setupProtocolAndTreasury`)

EVM port (this work): `packages/program-evm/protocol-evm-v1/`
- `src/{ArcConfig,PactRegistry,PactPool,PactSettler}.sol`,
  `src/PactEvents.sol`, `src/errors/PactErrors.sol`,
  `src/libraries/FeeValidation.sol`, `src/interfaces/I*.sol`
- `test/{ArcConstants,Deployment,FeeValidation,PactRegistry,PactPool}.t.sol`,
  `test/util/MockUSDC.sol`

Specs/plans:
- `docs/superpowers/specs/2026-05-15-arc-parity-port-design.md` (§3 invariants,
  §4 divergence ledger, §6 module structure, §8 WP waves)
- `docs/superpowers/plans/2026-05-15-arc-parity-port.md` (WP-02 + WP-03
  detailed; WP-04..06 scoped — WP-04/05 detailed via GSD at turn)
- This handoff: `docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md`

---

## WP-EVM-04 OUTCOMES (LOCKED — read before WP-EVM-05)

WP-EVM-04 (PactSettler happy path) is COMPLETE: captain GATE A + GATE B
approved, gsd-verifier passed (8/8 must-haves, `04-VERIFICATION.md`),
`forge build` clean, `forge test` 90/90 (0 failed; full WP-02/03 regression
held), phase 04 marked complete, pushed (`feat/arc-protocol-v1` @ `4cb699d`),
PR #204 completion comment posted. All §(b) WP-02/03 LOCKED rulings + the
§(c) methodology + §(e) conventions REMAIN IN FORCE. The following are now
ALSO settled law — do NOT re-derive.

### (a) WP-EVM-04 commit lineage (on `feat/arc-protocol-v1`)

- Planning/GATE-A: `8bf87d7` research · `4cc7f49` GSD scaffold + plans ·
  `05443db` GATE-A rulings + parity-seam fix (E1 hook split) · `4a6bac9`
  04-01 closure + sequential-exec config.
- 04-02 (foundation): `bd22432` PactSettler AccessControl (E2) · `0b01648`
  split E1 hooks (E1) · `566e695` PactSettler.t.sol harness · `e42c8ed`
  SUMMARY · `f0d68a1` REQUIREMENTS.
- 04-03 (guards/dedup/premium-in): `525e6a1` RED · `ce1c281` GREEN guards ·
  `3abe9c0` RED · `9602147` GREEN dedup+premium-in · `3a16d6b` SUMMARY.
- 04-04 (economic loop + 9 tests + GATE B): `f46a0b6` RED · `8cc7b1a` GREEN
  settleBatch loop · `8592faf` 9 ported tests · `ee26e2f` SUMMARY ·
  `ea9dc0d` orchestrator GATE-B addendum.
- GATE-B fix: `6adc459` RED precedence test · `4c2fd86` fix (the captain
  spot-checked diff) · `6f4db0a` report FIX section.
- Closeout: `d6c0bad` gsd-verifier VERIFICATION · phase-complete +
  STATE-complete commits.
- Canonical decision record: `.planning/phases/04-pactsettler-happy-path/04-GATE-A-DECISIONS.md`;
  outcome: `.../04-REPORT-gateB.md`; verification: `.../04-VERIFICATION.md`.

### (b) E1-E4 final resolutions — LOCKED

- **E1 (LOCKED):** `PactRegistry` now has OZ `AccessControl` +
  `SETTLER_ROLE` (`PactRegistry.sol:28,30`) and TWO SETTLER_ROLE-gated
  endpoint-stat hooks mirroring `settle_batch.rs`'s two `ep.*` mutation
  points: `recordCallAndCapAccrual(slug,premium,breach,intendedRefund)
  returns (uint64 payableRefund)` (`PactRegistry.sol:244`; ports
  `settle_batch.rs:385-414` — totalCalls/totalPremiums/totalBreaches,
  the WP-04 hourly PERIOD RESET `:396-399` at `PactRegistry.sol:260-263`,
  then `currentPeriodRefunds += payableRefund`) called BEFORE fee fan-out;
  and `recordRefundPaid(slug,actualRefund)` (`PactRegistry.sol:284`; ports
  `settle_batch.rs:493-499` — `totalRefunds += actual`) called AFTER the
  refund transfer. Both `onlyRole(SETTLER_ROLE)`, checked →
  `ArithmeticOverflow`. **D1-SCOPE REFINEMENT (now LOCKED ruling #8):**
  WP-03 ruling D1 ("NO modification of committed WP-02 `PactRegistry`")
  was scoped to `PactPool` reaching into the registry — it does NOT bar
  WP-04+ adding their own SETTLER_ROLE-gated writers where design-spec §6
  places `EndpointConfig` state. This refinement (NOT a contradiction) is
  hereby appended to the §(b) locked-rulings list as ruling #8; WP-06 §(d)
  formally records it in the spec.
- **E2 (LOCKED):** `PactSettler` is `IPactSettler, AccessControl`, 3-arg
  ctor `(usdc_, registry_, pool_)` (dropped `address settler_`),
  `DEFAULT_ADMIN_ROLE → registry.authority()`, `settleBatch` is
  `onlyRole(SETTLER_ROLE)`. The deployed `PactSettler` MUST hold
  `SETTLER_ROLE` on BOTH `PactPool` AND `PactRegistry` (two-layer grant;
  wired in `PactSettler.t.sol` setUp; `Deployment.t.sol` is 3-arg).
- **E3 (LOCKED):** emit exactly ONE `IPactSettler.CallSettled` (typed
  enum) per call (DelegateFailed path + Settled path each emit once);
  `PactEvents.CallSettled` is an indexer-facing alias with byte-identical
  topic0 (enum encodes as `uint8` in the signature) — asserted by
  `test_CallSettled_ABI_Identity`. No second emission anywhere.
- **E4 (LOCKED):** no `CallRecord` on EVM. `mapping(bytes16=>bool)
  _settledCallIds` is the only persisted per-call state; it is SET
  (`PactSettler.sol:98`) BEFORE the premium-in `try IERC20.transferFrom`
  (`PactSettler.sol:106`) so a `DelegateFailed` event still consumes the
  callId and is not retryable — source-verified `settle_batch.rs:243-262`
  (CallRecord allocated up-front; DelegateFailed path writes it). The `05`
  byte assertions (`cr[2]`/`readU64(cr,80)`/`readU64(cr,88)`) are ported
  to `vm.expectEmit` on `CallSettled.{status,refund,actualRefund}`.

### (c) Guard-precedence LOCKED ordering (WP-05 MUST preserve)

Per-event order in `PactSettler.settleBatch`, bit-identical to
`settle_batch.rs` and pinned by `test_DuplicateCallIdPrecedesRecipientCoverageMismatch`:

`guards (timestamp :158 / MIN_PREMIUM :161 / feeCountHint :164)` →
**`DuplicateCallId` dedup READ** (`PactSettler.sol:84`, `settle_batch.rs:194`)
→ endpoint snapshot **`RecipientCoverageMismatch`** (`PactSettler.sol:89-91`,
`settle_batch.rs:213`) → **dedup SET** (`PactSettler.sol:98`,
`settle_batch.rs:248-262`) → **premium-in** (`PactSettler.sol:106`).
An input that is BOTH a replayed callId AND `feeCountHint != stored count`
MUST revert `DuplicateCallId` (same input → same error as Solana). WP-05's
`EndpointPaused` (`settle_batch.rs:209`) slots BETWEEN the dedup READ and
`RecipientCoverageMismatch` (additive, no WP-04 rewrite). Re-derived
`settle_batch.rs:144-262` confirmed this is the only WP-04 ordering point;
everything else between guards and `:194` is N-A-on-EVM.

### (d) EXACT WP-05 additive seams left in code (file:line)

WP-05 inserts these ADDITIVELY — do NOT rewrite WP-04 shape (line numbers
are post-fix `4cb699d`; the `settle_batch.rs` anchors are authoritative):

1. **`ExposureCapClamped`** — inside `PactRegistry.recordCallAndCapAccrual`,
   BETWEEN the period reset (`PactRegistry.sol:260-263`) and the
   `currentPeriodRefunds` accrual (`PactRegistry.sol:274-275`). The exact
   insertion is spelled out as a comment at `PactRegistry.sol:265-271`
   (`capRemaining = exposureCapPerHour.saturatingSub(currentPeriodRefunds);
   if (payableRefund > capRemaining) { payableRefund = capRemaining; status
   = ExposureCapClamped; }`). WP-05 adjusts the returned `payableRefund`;
   the `PactSettler` call site is unchanged. Ports `settle_batch.rs:400-408`.
2. **`PoolDepleted`** — the EMPTY `if (ps.currentBalance < payableRefund) {}`
   block in `PactSettler._settleSuccess` (`PactSettler.sol:200-201`,
   comment `:195,:201`). WP-05 sets `status = PoolDepleted; actualRefund =
   0` here; the populated `else` (payout + debitForRefund) stays. Ports
   `settle_batch.rs:462-469`.
3. **Pause kill-switches** — protocol-paused fast-revert PRE-loop (before
   any per-event work, `settle_batch.rs:99-115`) and per-event
   `EndpointPaused` (`settle_batch.rs:209`, slots into the precedence order
   per §(c)). Not present in WP-04.
4. **`BatchTooLarge`** — `events.length > MAX_BATCH_SIZE (50)` pre-loop
   (`settle_batch.rs:133-135`). Not present in WP-04.

### (e) WP-EVM-05 scope (D-SPLIT reading A — LOCKED)

WP-05 = the 4 deferred `05-settle-batch.test.ts` clamp/kill-switch tests
(pool-depleted → `PoolDepleted`; exposure-cap-clamp → `ExposureCapClamped`;
`ProtocolPaused` when paused=1; resume-after-unpause) PLUS the full ports
of `tests/06-pause.test.ts`, `tests/07-exposure-cap.test.ts`,
`tests/10-pause-protocol.test.ts`, `tests/09-auth-pda.test.ts` (auth →
`SETTLER_ROLE` model). Parity invariants: hourly rolling-window reset is
ALREADY WP-04 (in `recordCallAndCapAccrual` — do NOT re-implement; WP-05
only adds the clamp DECISION); clamp ordering pool-balance THEN exposure
cap; protocol-paused fast-revert before any per-event work or transfer.
Config flag: WP-05 SHOULD enable a settlement threat-model / adversarial
pass (Nyquist/security were intentionally OFF for WP-04); WP-06 fuzz/gas
covers statistical adequacy.

### (f) WP-EVM-05 process

WP-05 is GSD per spec §8: `/gsd:plan-phase` then `/gsd:execute-phase`
(the `.planning/` scaffold + ROADMAP Phase 5 `wp-evm-05-pactsettler-hardening`
already exist; STATE.md advanced to Phase 5). Same captain gate cadence:
(1) plan-review gate (GATE A) — author plan, report, WAIT for approval
BEFORE any Solidity; (2) final parity gate (GATE B) — after impl +
`forge build && forge test` green, report, WAIT, NO push / NO PR #204
comment until approved. Same methodology (§c — Solana source authority,
STOP-AND-ASK on parity ambiguity, strict TDD RED-before-GREEN, file-scoped
conventional commits), contamination guardrail (§e — only
`?? .claude/pr-reviews/` expected; never touch `CLAUDE.md`/`.claude/skills`),
and file-report convention (gate reports →
`.planning/phases/<phase>/<phase>-REPORT-<gate>.md` AND a short
`cockpit runtime send pact-network` notice). GSD `use_worktrees:false` +
`code_review:false` + Nyquist/security off are set in `.planning/config.json`
(WP-05 may re-enable a threat-model pass per §(e)).

---

## WP-EVM-05 OUTCOMES (LOCKED — read before WP-EVM-06)

WP-EVM-05 (PactSettler hardening) is COMPLETE: captain GATE A + GATE B
approved (verdict files `.planning/phases/05-wp-evm-05-pactsettler-hardening/05-CAPTAIN-GATE-A-VERDICT.md`
and `05-CAPTAIN-GATE-B-VERDICT.md`), gsd-verifier passed (12/12 must-haves,
`05-VERIFICATION.md`), `forge build` clean, `forge test` 102/102 (0 failed;
90 WP-04 regression preserved + 12 WP-05; PactSettler suite 20 -> 32), phase
05 marked complete in ROADMAP/STATE, pushed (`feat/arc-protocol-v1` @
`b601982`), PR #204 completion comment posted. ALL §(b) WP-02/03 LOCKED
rulings + ruling #8 (D1-scope refinement) + the §(c) methodology + §(e)
conventions + the WP-EVM-04 OUTCOMES E1-E4/guard-precedence/seams REMAIN IN
FORCE. The following are now ALSO settled law — do NOT re-derive or reopen.

### (a) WP-EVM-05 commit lineage (on `feat/arc-protocol-v1`)

- GATE-A: `111bc8a` 05-GATE-A-DECISIONS record (also `97576bc` research ·
  `379200a` plan-phase artifacts + GATE-A request).
- 05-02 (ProtocolPaused + BatchTooLarge): `89f43b7` RED · `26c6d3c` GREEN ·
  `155b096` bookkeeping.
- 05-03 (EndpointPaused @ D-LOCK-PREC slot): `c14a254` RED · `5e47e3a` GREEN
  · `385f7b5` bookkeeping.
- 05-04 (ExposureCapClamped + P1): `7eecfdb` RED · `323699e` GREEN cap clamp
  · `2157b75` GREEN P1 inference (the RATIFIED stack-too-deep alias inline) ·
  `d7ee074` bookkeeping.
- 05-05 (PoolDepleted): `5954ba3` RED · `5339316` GREEN · `3bf2a45`
  bookkeeping.
- 05-06 (N-A matrix + adversarial pass + regression): `c7ab3ed` ·
  `c3c2297` · `7bfb683`.
- Closeout: `139d775` GATE-B request · `2a4d8b0` gsd-verifier VERIFICATION +
  STATE · `b601982` ROADMAP Phase-5 `[x]`.
- Canonical records: `05-GATE-A-DECISIONS.md`, `05-CAPTAIN-GATE-A-VERDICT.md`,
  `05-CAPTAIN-GATE-B-VERDICT.md`, `05-VERIFICATION.md`, `05-NA-MATRIX.md`,
  `05-REPORT-gateA.md`, `05-REPORT-gateB.md`.

### (b) P1 / P3 final implemented forms — LOCKED

- **P1 (LOCKED):** ExposureCapClamped status is INFERRED in
  `PactSettler._settleSuccess` via `if (payableRefund < ev.refund) { status =
  SettlementStatus.ExposureCapClamped; }` (`PactSettler.sol:192-193`), set
  AFTER the (unchanged) `recordCallAndCapAccrual` call and BEFORE the
  pool-balance check (`PactSettler.sol:220`) so a later PoolDepleted
  overwrites it. `payableRefund < ev.refund` is provably equivalent to Solana
  `intended > cap_remaining` at every boundary (clamp / no-clamp / `==` /
  `intended==0`), because WP-04 seeded `intendedRefundAfterCap = ev.refund`
  and never mutated it and Solana seeds `intended_refund_after_cap =
  refund_lamports` (`settle_batch.rs:380`). The seam-pinned
  `recordCallAndCapAccrual` signature (`PactRegistry.sol:244-249`) is
  UNCHANGED — no bool/enum return. `currentPeriodRefunds` accrues the CLAMPED
  amount inside `recordCallAndCapAccrual` and is NEVER rolled back
  (`recordRefundPaid` is only called when `actualRefund > 0`). **The
  `2157b75` alias inline (`intendedRefundAfterCap` -> `ev.refund`, one WP-04
  alias line, compiler-forced stack-too-deep from the new `status` local) is
  LOCKED-ACCEPTED** — captain-ratified at GATE B as provably parity-neutral;
  do NOT "fix"/revert it.
- **P3 (LOCKED — OPTIMIZED-DIVERGENCE):** `settleBatch` keeps the WP-04
  `onlyRole(SETTLER_ROLE)` modifier; the protocol-paused fast-revert is the
  first body statement. For the unauthorized-caller-AND-paused corner, EVM
  returns `AccessControlUnauthorizedAccount` (modifier before body) while
  Solana returns `ProtocolPaused` (`settle_batch.rs:99-115` before
  `:117-130`). Authorized-settler+paused is IDENTICAL on both chains
  (`ProtocolPaused`). Only the operationally-real paths are tested
  (`test_ProtocolPaused_RejectsSettleBatch`,
  `test_ProtocolPaused_ResumesAfterUnpause`); NO test asserts Solana behavior
  for the unauthorized+paused corner — it is a WP-06 parity-matrix entry, not
  a defect. The alternative (in-body `_checkRole` after the pause check)
  rewrites the LOCKED WP-04 E2 shape and is FORBIDDEN.

### (c) The 4 filled seams — final file:line (post `b601982`)

ADDITIVE fills; no WP-04 reorder/rewrite (except the LOCKED `2157b75`
alias). Anchors authoritative; `settle_batch.rs` is the parity authority.

1. **ProtocolPaused** `PactSettler.sol:70`
   (`if (registry.protocolPaused()) revert ProtocolPaused();`, first body
   statement) + **BatchTooLarge** `PactSettler.sol:74`
   (`if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();`,
   strict `>`, 50 OK / 51 reverts) — ports `settle_batch.rs:99-115` then
   `:132-135`, in that order, pre-loop.
2. **EndpointPaused** `PactSettler.sol:102`
   (`if (ep.paused) revert EndpointPaused();`) at the D-LOCK-PREC slot:
   dedup READ `:94` < EndpointPaused `:102` < RecipientCoverageMismatch
   `:104` < dedup SET `:111` — ports `settle_batch.rs:209` (after `:194`,
   before `:213`). LOCKED test `test_DuplicateCallIdPrecedesRecipientCoverageMismatch`
   stays green.
3. **ExposureCapClamped** — cap clamp in
   `PactRegistry.recordCallAndCapAccrual` between
   `payableRefund = intendedRefund;` (`PactRegistry.sol:264`) and the
   `currentPeriodRefunds` accrual (`PactRegistry.sol:280`): ternary
   `capRemaining` (`:271`) parity-exact to `saturating_sub`
   (`exposureCap <= currentPeriodRefunds => 0`, no underflow), clamp at
   `:274`. P1 inference at `PactSettler.sol:192-193`. Ports
   `settle_batch.rs:400-414`.
4. **PoolDepleted** `PactSettler.sol:232`
   (`status = SettlementStatus.PoolDepleted; actualRefund = 0;`) filling the
   formerly-empty `if (ps.currentBalance < payableRefund)` block
   (`:220`); the WP-04 `else` is byte-unchanged. Ports
   `settle_batch.rs:462-469`. The emit uses `status`
   (`PactSettler.sol:263`). D-LOCK-CLAMP-ORDER (PoolDepleted overwrites
   ExposureCapClamped) is proven by a combined test.

### (d) CONSOLIDATED WP-EVM-06 spec-defect / parity-matrix worklist

WP-06 MUST produce the per-variant parity matrix (each PactError variant +
each behavior tagged IDENTICAL / OPTIMIZED-DIVERGENCE / N-A-ON-EVM with
rationale) AND formally correct the design spec for ALL of the following.
This list is now COMPLETE and CLOSED — no item may be dropped:

1. Design-spec §3 enumerated `PactError` list omits `FeeBpsSumOver10k`
   (6018) — add it; `error.rs` has 30 variants. (§(d)#1, original.)
2. §4 #7 wording "InvalidAffiliateAta unreachable / N-A" is wrong — it is
   OPTIMIZED-DIVERGENCE (zero-address affiliate guard). Only
   `FeeRecipientInvalidUsdcMint` is true N-A. (§(d)#2, original.)
3. `updateEndpointConfig` per-field-flags -> full-typed-set mechanism
   divergence (state parity preserved). (§(d)#3, original.)
4. D2: `CoveragePool.created_at` set lazily at first `topUp` on EVM
   (informational-only; Solana sets at register). (§(d)#4, original.)
5. **Locked ruling #8 (D1-scope refinement):** WP-03 D1 ("NO modification of
   committed WP-02 `PactRegistry`") was scoped to `PactPool` reaching into
   the registry; it does NOT bar WP-04+ adding their own SETTLER_ROLE-gated
   writers where design-spec §6 places `EndpointConfig` state. Formally
   append to the spec.
6. **P3 OPTIMIZED-DIVERGENCE corner:** unauthorized-caller-AND-paused returns
   `AccessControlUnauthorizedAccount` on EVM vs `ProtocolPaused` on Solana
   (operationally meaningless; authorized+paused identical). Matrix entry +
   spec note. Full text in `05-NA-MATRIX.md` "P3 OPTIMIZED-DIVERGENCE Corner".
7. **N-A-ON-EVM rows from `05-NA-MATRIX.md`** (each with the surviving WP-02
   authority-invariant test): `09:47`, `09:78` (pause_endpoint fake /
   wrong-owner ProtocolConfig); `09:144` (update_endpoint_config fake
   ProtocolConfig); `09:172` (update_fee_recipients fake Treasury PDA);
   `10:94`, `10:128` (pause_protocol fake / wrong-owner ProtocolConfig);
   `D-LOCK-EXPCAP-NA` (`ExposureCapExceeded` 6002 has no `settle_batch`
   trigger — the cap clamps to a status, never reverts). Surviving tests:
   `test_PauseEndpoint_RejectsNonAuthority`,
   `test_UpdateEndpointConfig_RejectsNonAuthority`,
   `test_UpdateFeeRecipients_RejectsNonAuthority`,
   `test_PauseProtocol_RejectsNonAuthority` (all PASS).
8. **WP-02/03/04 N-A items** already recorded in this handoff: §(b)#2
   `FeeRecipientInvalidUsdcMint` (true N-A, SPL-mint platform check); WP-04
   E4 byte-layout assertions (`CallRecord` -> `vm.expectEmit` on
   `CallSettled`); and the §(c)/D-LOCK-5 class of genuine Solana-platform
   mechanics (PDA derivation/`InvalidSeeds`, `AccountAlreadyInitialized`,
   signer/rent/`system_program`, byte-offset/layout, SPL-mint constants).
   WP-06 folds these into the single per-variant matrix.

Source N-A rationales + the bounded adversarial-pass review (3 vectors, all
CLEAN) live in full in
`.planning/phases/05-wp-evm-05-pactsettler-hardening/05-NA-MATRIX.md` — WP-06
reads it verbatim; do not re-derive.

### (e) WP-EVM-06 scope

- `@pact-network/protocol-evm-v1-client` — NEW pnpm workspace member at
  `packages/protocol-evm-v1-client/` (viem), sibling to
  `packages/protocol-v1-client/`, mirroring its module map
  (`addresses.ts`/`encode.ts`/`state.ts`/`errors.ts`/`constants.ts`/
  `helpers.ts`) per design-spec §5.
- Consolidated forge **fuzz** + **gas-snapshot** suite (fee-split integer
  rounding, batch handling) on top of the 102 ported scenario tests.
- The live `IERC20(USDC).decimals() == 6` assertion deferred from
  WP-EVM-01.
- The per-variant **parity-matrix doc** AND the formal design-spec
  corrections for ALL §(d) items 1-8 above.
- Out of scope: WP-07 (deploy/verify, separate cycle); any WP-02/03/04/05
  reopen.

### (f) WP-EVM-06 process

WP-06 is **authored-at-turn** (lighter than the settler WPs — NOT
necessarily GSD; the captain decides the plan method at WP-06 GATE A). Same
captain gate cadence as WP-02..05: (1) plan-review GATE A — author the plan,
write `.planning/phases/<06-...>/06-REPORT-gateA.md` AND a short
`cockpit runtime send pact-network` notice (the FILE is the source of truth;
the relay misroutes), WAIT for the captain verdict (delivered as a file)
BEFORE any client/suite code; (2) final GATE B — after build/test green,
write `06-REPORT-gateB.md` + cockpit notice, WAIT, NO push / NO PR #204
comment until captain approval. Same methodology (§c — Solana source
authority, STOP-AND-ASK on parity ambiguity, strict TDD RED-before-GREEN,
file-scoped conventional commits, no emojis, pnpm/forge never npm),
contamination guardrail (§e — only `?? .claude/pr-reviews/` expected; never
touch `CLAUDE.md`/`.claude/skills`; never run a `pact` skill installer),
GitNexus deferral (§e), and file-report convention. ALL WP-02/03/04/05
locked rulings + the §(b) list + ruling #8 + WP-04 OUTCOMES + WP-05 OUTCOMES
remain intact and are NOT reopened.

---

## PARITY PORT COMPLETE — WP-07 deploy prerequisites (2026-05-19)

WP-EVM-06 is COMPLETE: captain GATE A + GATE B APPROVED (independently
verified), authored-at-turn (NOT GSD — the correct method call). **The Arc
EVM behavioral-parity port (WP-EVM-02..06) is COMPLETE.** Everything above
this section remains settled law and is NOT reopened. Only WP-EVM-07 (Arc
testnet deploy + arcscan verify) remains — a SEPARATE cycle, captain/Rick
-initiated, explicitly out of the parity scope.

### (a) Parity-complete state + full WP-02..06 lineage

- Parity-complete at `fa6f023` (pushed `origin/feat/arc-protocol-v1`,
  `fd18f4d..fa6f023`). PR #204 PORT-COMPLETION comment posted
  (`pull/204#issuecomment-4480443276`). This completion section + final
  tracking are docs commits on top.
- WP-02: `62ae70b`/`8a85e02`/`74a6ddf`/`531995a`/`d6c8460`/`35565c6`/
  `24ccc42`. WP-03: `8369f8a`/`c44f7bd`/`467c4a0`/`9d25856`/`de3f15e`.
  WP-04: `4cb699d` (final) + lineage in "WP-EVM-04 OUTCOMES" §(a).
  WP-05: `b601982` (final) + lineage in "WP-EVM-05 OUTCOMES" §(a).
  WP-06: `73cde55` GATE-A · `0c82e52` scaffold+D-A drift guard ·
  `6f52e07` T2 · `0b1efa8` T3 · `bf448a9` T4 · `a02b191` T5 · `6b8d301` T6 ·
  `cc15f4c` T7 fuzz+gas · `585086b` T8 USDC-decimals · `af6891d` T9 matrix ·
  `7db633c` T10 spec corrections · `203e1b5` GATE-B · `3073990`
  milestone-complete · `fa6f023` GATE-B verdict.
- Final test totals: **forge 109/109** (102 ported regression preserved + 5
  fuzz @257 runs + 2 USDC-decimals); **client 41/41**; D-A drift guard PASS
  (T1/T7/T11).

### (b) Authoritative docs for WP-07 / future readers — USE THE CORRECTED SPEC

- Parity matrix (per-variant proof, the canonical divergence record):
  `docs/superpowers/specs/2026-05-18-arc-parity-matrix.md` — 30/30
  `PactError` variants + §3 behaviors + §(d) 1-8 + `05-NA-MATRIX` rows + P3,
  each tagged IDENTICAL / OPTIMIZED-DIVERGENCE / N-A-ON-EVM with file:line.
- Design spec `docs/superpowers/specs/2026-05-15-arc-parity-port-design.md`
  is now FORMALLY CORRECTED (all §(d) 1-8; "WP-EVM-06 Corrections"
  appendix; §3 → 30 variants; §4 #7 fixed; §4 rows 9/10; PR #201 §7.1
  corrected). WP-07 and future readers MUST use the corrected spec + the
  matrix, not the pre-correction text.

### (c) What WP-07 needs concretely (deploy cycle)

- **Fill the deployed addresses:** `packages/protocol-evm-v1-client/
  src/addresses.ts` ships Arc Testnet chain id + USDC populated and the
  protocol contract addresses (`registry`/`pool`/`settler`) as `null`
  placeholders. Post-deploy, set them via the env overlay
  (`resolveDeployment(chainId, env)` reads `PACT_EVM_REGISTRY`/
  `PACT_EVM_POOL`/`PACT_EVM_SETTLER`, checksum-validated) and/or bake the
  final addresses into `DEPLOYMENTS`.
- **USDC decimals guard already in place:** the live
  `IERC20(USDC).decimals()==6` assertion is enforced
  (`test/UsdcDecimals.t.sol`) with a reusable `require()`-shaped guard;
  wire the same guard into the WP-07 deploy script so a wrong-decimals USDC
  fails the deploy loudly.
- **Committed-ABI regen/drift guard:** `packages/protocol-evm-v1-client/
  scripts/gen-abi.mjs` regenerates `src/abi/*.ts` from the forge build +
  locked `PactErrors.sol`; `scripts/check-abi-drift.mjs`
  (`pnpm --filter @pact-network/protocol-evm-v1-client check:abi`) fails
  loudly on any drift vs the locked contracts. Run `check:abi` in WP-07 CI
  before/after deploy to prove the deployed bytecode's ABI still matches the
  committed client ABI.
- **NO contract change is permitted at deploy.** The contracts are LOCKED
  through WP-05; WP-06 added ZERO contract behavior (additive: 2 forge test
  files + 1 comment-only `ArcConfig` line + the client package + 2 docs).
  WP-07 is deploy + verify ONLY — any contract edit is a new captain-gated
  cycle, not WP-07.

### (d) Locked rulings remain in force

ALL WP-02/03 §(b) rulings 1-7 + ruling #8 (D1-scope refinement) + §(c)
methodology + §(e) conventions + WP-04 OUTCOMES (E1-E4 / guard precedence /
seams) + WP-05 OUTCOMES (P1/P3 final forms, the LOCKED-ACCEPTED `2157b75`
alias, the 4 filled seams) remain intact and are NOT reopened by WP-07 or any
future work. The parity port is closed.
