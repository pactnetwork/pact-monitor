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
