# Phase 4: WP-EVM-04 PactSettler Happy Path - Context

**Gathered:** 2026-05-18
**Status:** Ready for planning
**Source:** Locked port artifacts (handoff + design spec + impl plan). This is
a PORT, not a redesign. NOTHING in this file is open for re-derivation by the
researcher/planner — the rulings below are settled law. The only OPEN items are
the explicitly-labelled GATE A design decisions E1-E4, which the captain rules;
the planner records them AS decisions, it does NOT silently resolve them.

<domain>
## Phase Boundary

Implement `PactSettler.settleBatch` HAPPY PATH as a bit-identical behavioral
port of the per-event loop in
`packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs`,
composing the already-shipped WP-03 `PactPool` SETTLER_ROLE hooks
(`creditPremium`/`debitForFees`/`debitForRefund`/`payout`). Port the
HAPPY-PATH SUBSET of `tests/05-settle-batch.test.ts` to a forge-std Foundry
suite; every Solana balance/amount/status assertion reproduced exactly.

**IN scope (WP-EVM-04):**
- Settler-role gate on `settleBatch` (SET-01).
- Per-event guards: `MIN_PREMIUM` floor, `timestamp > now`,
  `feeRecipientCountHint` vs stored count (SET-03).
- Dedup via `mapping(bytes16 => bool)` → `DuplicateCallId` (SET-04).
- Premium-in `transferFrom(agent, pool, premium)` try/catch → `DelegateFailed`,
  no funds move, batch continues (SET-02, §4#1).
- Pool gross credit + fee fan-out `premium*bps/10_000` floor div, pool keeps
  residual (SET-05).
- Refund on breach when pool has liquidity AND within cap → full refund,
  status `Settled` (SET-06).
- Pool + endpoint stats accounting with identical arithmetic/ordering (SET-07).
- One `CallSettled` event per call (SET-08).
- Ported happy-path subset of `05-settle-batch.test.ts`; existing 70 tests
  stay green.

**OUT of scope (deferred to WP-EVM-05 — do NOT implement here):**
- `PoolDepleted` clamp (refund > pool balance).
- `ExposureCapClamped` clamp + the hourly rolling-window *enforcement*
  (`current_period_start`/`current_period_refunds` reset + cap-remaining
  saturating-sub clamp branch). See E-decision note on accounting vs clamp.
- Protocol-paused fast-revert (`ProtocolPaused`) and endpoint-paused per event.
- `BatchTooLarge` (batch > MAX_BATCH_SIZE) edge.
- Ports of `06-pause.test.ts`, `07-exposure-cap.test.ts`,
  `10-pause-protocol.test.ts`, `09-auth-pda.test.ts`, and the clamp/kill-switch
  subset of `05-settle-batch.test.ts`.
</domain>

<decisions>
## Implementation Decisions

### LOCKED rulings — settled law (handoff §b/§c; do NOT re-litigate)

- **D-LOCK-1:** Solana `settle_batch.rs` is the sole parity authority. Where
  the design spec / impl plan / scaffold comments / this file's prose conflict
  with `settle_batch.rs`, the Rust source wins. Plan/spec code blocks and
  scaffold `TODO(...)` comments are NON-authoritative sketches.
- **D-LOCK-2:** Strict TDD — write the failing Foundry test, run it, confirm
  RED, implement, run, confirm GREEN. Never skip the red step. The ported
  LiteSVM scenarios + source-enforced invariants ARE the validation strategy
  (no separate Nyquist/security ceremony — that is intentionally disabled).
- **D-LOCK-3:** Divergence ledger (design-spec §4) is closed. Relevant here:
  §4#1 ERC-20 `transferFrom` + try/catch == `DelegateFailed`;
  §4#2 single contract + `mapping(bytes16 slug => …)` (no per-endpoint PDAs);
  §4#3 first-class `event` per state transition is the indexer truth source
  (EVM has NO `CallRecord` account — see E4);
  §4#4 `uint64` value widths, Solidity-native packing;
  §4#5 OZ `AccessControl` `SETTLER_ROLE` (the contract is the ERC-20 spender);
  §4#8 USDC is the 6-dec ERC-20, `uint64` amounts retained.
- **D-LOCK-4:** Pool decisions D1-D6 (WP-03, captain-approved) stand. The pool
  hooks are `onlyRole(SETTLER_ROLE)` and `registry.isRegistered(slug)`-gated;
  `_ckAdd`/`_ckSub` mirror `checked_add`/`checked_sub` →
  `ArithmeticOverflow`. WP-04 COMPOSES them; it does NOT reopen D1-D6.
- **D-LOCK-5:** PORT vs N-A rule (handoff §c). PORT every scenario whose
  behavior survives the §4 ledger. Mark N-A-ON-EVM only for genuine
  Solana-platform mechanics (PDA derivation/`InvalidSeeds`,
  `AccountAlreadyInitialized`, `NotEnoughAccountKeys`/signer/rent/
  `system_program`, byte-offset/layout asserts, SPL-mint constant checks).
  Every N-A gets a one-line rationale recorded for the WP-06 parity matrix.
- **D-LOCK-6:** Conventions — no emojis anywhere; conventional commits;
  `pnpm`+`forge` never `npm`; file-scoped commits (NO `git add -A`/`-a`),
  one logical change per commit; NO push / NO PR #204 comment until the
  captain approves the WP-04 final gate. Working tree stays clean (only
  `?? .claude/pr-reviews/` is expected; if `CLAUDE.md` shows ` M` or
  `.claude/skills/pact/` appears, STOP and report — contamination).

### WP-04 vs WP-05 scope split (reading A — confirm at GATE A)

- **D-SPLIT:** `tests/05-settle-batch.test.ts` has 13 tests spanning BOTH
  happy path and clamp/kill-switch. Handoff §(f) ("WP-04 ... + ported
  `tests/05-settle-batch.test.ts`") read in isolation is ambiguous, but
  handoff §(g) closing ("WP-04 = happy path; WP-05 = the clamps + the kill
  switches + batch edges") and design-spec §8 ("WP-04 happy path" vs "WP-05
  hardening: exposure cap, pool-depleted, kill switches, batch limits") are
  explicit. The only internally-consistent reading: **WP-04 ports the
  happy-path subset; the clamp/kill-switch subset of `05` defers to WP-05**
  alongside `06/07/09/10`. Captain confirms this split at GATE A.
  - **WP-04 ports (9):** "single event default 10% Treasury fan-out";
    "explicit Treasury 10% + Affiliate 5% (85/10/5)"; "breach event refunds
    agent ATA from pool vault"; "mixed batch across 3 endpoints"; "revoke
    between events → DelegateFailed and continues"; "min-premium edge
    rejected"; "duplicate call_id rejected"; "unauthorized settler rejected";
    "happy path: settlement_status = Settled (0)" (full refund, pool funded,
    within cap — no clamp triggers).
  - **WP-05 defers (4):** "pool depleted: PoolDepleted"; "exposure cap clamps:
    ExposureCapClamped"; "rejects with ProtocolPaused when paused=1";
    "resumes after pause → unpause".

### OPEN — GATE A design decisions (captain rules; planner records, not resolves)

- **E1 (PRIMARY) — endpoint-stats write path.** `settle_batch.rs:385-498`
  mutates `EndpointConfig` stats (`total_calls`, `total_premiums`,
  `total_breaches`, `total_refunds`) and the period fields
  (`current_period_start`, `current_period_refunds`). `IPactRegistry` exposes
  `getEndpoint`/`isRegistered` (reads) but NO settler-gated write path, and
  WP-03's D1 stated "NO modification of committed WP-02 `PactRegistry`."
  Parity (spec §3 "stats accounting … identical arithmetic and ordering")
  REQUIRES persisting these. Candidate resolutions for the captain:
  (a) extend `PactRegistry` with SETTLER_ROLE-gated endpoint-stats hook(s)
      symmetric to the WP-03 pool hooks (§4#5 pattern) — touches committed
      WP-02 contract;
  (b) hold endpoint settlement-stats in `PactSettler` storage — diverges from
      design-spec §6 (EndpointConfig is registry state) and splits state read
      by the indexer / `getEndpoint`;
  (c) other.
  Lead analysis: (a) is the only spec-§6-faithful, §4#5-symmetric option and
  the handoff §(g)#3-6 explicitly says WP-04 performs `ep.*` mutations, so the
  D1 "no-modify" was scoped to WP-03's pool→registry reach, not WP-04's own
  stat hooks. **Do NOT implement until the captain rules E1.**
- **E2 — SETTLER_ROLE gate location.** `PactSettler.sol` scaffold comment
  says `SETTLER_ROLE`/AccessControl is `TODO(WP-EVM-05)` and `settler` is a
  plain address. Handoff §(f)/§(g)#8 + spec §4#5 put the role gate in WP-04
  (required for `05` "unauthorized settler rejected"). Per D-LOCK-1 the
  scaffold `TODO` is a non-authoritative WP-01 sketch superseded by the
  handoff. Lead resolution: WP-04 implements OZ `AccessControl` `SETTLER_ROLE`
  on `PactSettler`; the deployed `PactSettler` is granted `PactPool`'s
  `SETTLER_ROLE`. Captain confirms.
- **E3 — `CallSettled` event consolidation.** Two declarations exist:
  `IPactSettler.CallSettled` (status as `SettlementStatus` enum) and
  `PactEvents.CallSettled` (status as `uint8`). Same ABI (enum encodes as
  uint8). Lead resolution: emit the `IPactSettler` typed-enum event; treat
  `PactEvents` as the indexer-facing alias (no second emission). Captain
  confirms; planner records.
- **E4 — CallRecord → event-as-truth.** Solana writes a `CallRecord` PDA;
  `05` tests assert its bytes (`cr[2]` status, `readU64(cr,80)` intended
  refund, `readU64(cr,88)` actual refund). EVM has no `CallRecord` (§4#3 /
  §4#2). Lead resolution: those byte-level assertions port to
  `vm.expectEmit` assertions on `CallSettled` (`status`, `refund`,
  `actualRefund`); the dedup `mapping` is the only persisted per-call state.
  Captain confirms; planner records.

### Claude's Discretion (within parity)

- Internal helper structure of `settleBatch` (loop layout, local caching of
  `getEndpoint`, single vs split storage reads) — provided economic outputs
  and mutation ORDERING match `settle_batch.rs` exactly and gas is reasonable.
- Foundry test util layout (mirror `tests/helpers.ts` builders as Solidity
  helpers) — provided every Solana assertion is reproduced.
</decisions>

<specifics>
## Specific Ideas — `settle_batch.rs` happy-path per-event order (authority)

Re-derive in full from source; this is orientation. Per event, in order:
1. (pre-loop, WP-05) protocol-paused; (per-event) settler-auth already
   checked once pre-loop. Batch-size guard is WP-05.
2. Decode event; `timestamp > now` → `InvalidTimestamp`;
   `premium < MIN_PREMIUM_LAMPORTS` → `PremiumTooSmall`;
   `fee_count_hint > MAX_FEE_RECIPIENTS` → `FeeRecipientArrayTooLong`.
3. Endpoint snapshot: (endpoint-paused → WP-05); `ep.fee_recipient_count !=
   fee_count_hint` → `RecipientCoverageMismatch`; capture
   `fee_recipients[]` + bps.
4. Dedup: non-empty CallRecord → `DuplicateCallId` (EVM: `mapping`).
5. Premium-in: delegate/allowance pre-flight; if not OK → status
   `DelegateFailed`, write record, `continue` (NO funds move). EVM: try/catch
   `transferFrom(agent, pool, premium)` (§4#1).
6. On success: pool `current_balance += premium; total_premiums += premium`
   (`:360-368` → `PactPool.creditPremium`).
7. Endpoint stats: `total_calls += 1; total_premiums += premium;
   if breach total_breaches += 1` (`:385-395`). Period reset + cap-remaining
   clamp branch is WP-05; the `current_period_refunds += refund` ACCOUNTING
   on a non-clamped refund is part of faithful refund bookkeeping — planner
   derives from source exactly which lines are WP-04 vs WP-05 (the clamp
   *decision* `status = ExposureCapClamped` and the period RESET are WP-05;
   pure additive accounting on a fully-paid refund is WP-04). Flag any
   ambiguity here — do NOT guess.
8. Fee fan-out: for each recipient `fee = premium*bps/10_000` (u128 math,
   floor); skip if 0; `payout` egress; `total_fee_paid += fee`. Then
   `current_balance -= total_fee_paid` (`:418-453` → `debitForFees` +
   `payout`).
9. Refund (breach): WP-04 happy = pool has liquidity AND within cap →
   `payout` pool→agent; `current_balance -= r; total_refunds += r`;
   `ep.total_refunds += r` (`:455-502` → `debitForRefund` + `payout`).
   The `pool_balance < r` (→ `PoolDepleted`) and cap-clamp branches are WP-05.
10. Status: `Settled` (or `DelegateFailed`). Emit `CallSettled` per call
    (EVM truth source — E4).

`SettlementStatus { Settled=0, DelegateFailed=1, PoolDepleted=2,
ExposureCapClamped=3 }` — WP-04 only produces 0 and 1.
</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before researching/planning/implementing.**

### Parity authority (Solana — source of truth)
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs` — THE WP-04 authority; the per-event loop.
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/state.rs` — `CoveragePool`, `EndpointConfig`, `CallRecord`, `SettlementStatus`, `FeeRecipient` field sets + arithmetic widths.
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/{constants.rs,error.rs}` — `MAX_BATCH_SIZE/MIN_PREMIUM_LAMPORTS/MAX_FEE_RECIPIENTS/ABSOLUTE_FEE_BPS_CAP`; 30 `PactError` variants + trigger conditions.

### Parity oracle (port the happy-path subset only)
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/tests/05-settle-batch.test.ts` — 13 tests; WP-04 ports the 9 happy-path tests (see D-SPLIT).
- `packages/program/programs-pinocchio/pact-network-v1-pinocchio/tests/helpers.ts` — builders/defaults (`setupProtocolAndTreasury`, `registerSimpleEndpoint`, `buildSettleBatch`, `fundPoolDirect`, `provisionAgent` pattern, `SettleEvent`) to mirror as Foundry utils.

### EVM port — current state (compose, do not reopen)
- `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` — WP-01 scaffold (`settleBatch` reverts `NOT_IMPLEMENTED`; 4-arg ctor; `settler` plain address — see E2).
- `packages/program-evm/protocol-evm-v1/src/interfaces/IPactSettler.sol` — `SettlementEvent`/`SettlementStatus`/`CallSettled`/`settleBatch` shapes (finalize against source).
- `packages/program-evm/protocol-evm-v1/src/PactPool.sol` + `interfaces/IPactPool.sol` — shipped SETTLER_ROLE hooks WP-04 composes; `PoolState` accounting.
- `packages/program-evm/protocol-evm-v1/src/interfaces/IPactRegistry.sol` — `EndpointConfig`/`FeeRecipient`, `getEndpoint`/`isRegistered`/`authority`/`treasuryVault`/`maxTotalFeeBps` (E1: no stats write path).
- `packages/program-evm/protocol-evm-v1/src/{ArcConfig.sol,errors/PactErrors.sol,PactEvents.sol}` — constants, 30 custom errors, event set.
- `packages/program-evm/protocol-evm-v1/test/{Deployment.t.sol,PactPool.t.sol}` — ctor wiring + role-grant + Foundry test patterns to follow.

### Locked process docs (settled law — do NOT re-derive)
- `docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md` — 7 LOCKED rulings, methodology, §(g) WP-04 orientation, contamination warning.
- `docs/superpowers/specs/2026-05-15-arc-parity-port-design.md` §3/§4/§6/§8.
- `docs/superpowers/plans/2026-05-15-arc-parity-port.md` (WP-04 scoped §1385).
- `CLAUDE.md` — project conventions (pnpm, no emojis, conventional commits).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PactPool.{creditPremium,debitForFees,debitForRefund,payout}` — settler-gated
  primitives that exactly mirror `settle_batch.rs:360-498` pool mutations.
  WP-04 grants the deployed `PactSettler` the pool's `SETTLER_ROLE` and calls
  these in source order.
- `PactPool._ckAdd/_ckSub` pattern (revert `ArithmeticOverflow`) — replicate
  for any `PactSettler`-local accumulators (`total_fee_paid`).
- `test/PactPool.t.sol` — established Foundry pattern: cache `SETTLER_ROLE()`,
  `vm.prank` discipline, MockUSDC usage.

### Established Patterns
- `mapping(bytes16 => …)` slug keying (§4#2); custom errors (no revert
  strings); `SafeERC20`; OZ `AccessControl` for roles (§4#5).

### Integration Points
- `PactSettler` → `IPactPool` (credit/debit/payout), `IPactRegistry`
  (`getEndpoint`/`isRegistered`/`authority`/`treasuryVault`), `IERC20` USDC
  (`transferFrom` premium-in). E1 resolves the endpoint-stats write edge.
- `Deployment.t.sol` ctor + role-grant wiring updates as the role model
  finalizes (E2).
</code_context>

<deferred>
## Deferred Ideas

- All WP-05 clamp/kill-switch/batch-edge behavior + ports of
  `06/07/09/10-*.test.ts` and the clamp/kill-switch subset of `05`.
- WP-06 TS client, fuzz/gas suite, parity matrix, formal spec-defect
  corrections (handoff §d).
- WP-07 deploy/verify.
- GSD Nyquist + security-threat-model gates intentionally disabled for this
  port (locked methodology = strict TDD + ported LiteSVM oracle). Captain may
  re-enable if a settlement threat model is wanted — flagged in GATE A report.
</deferred>

---

*Phase: 04-pactsettler-happy-path*
*Context bootstrapped 2026-05-18 by the WP-EVM-04 crew (fresh resume). No
discuss-phase: the design is locked law per the handoff; re-derivation is
forbidden. Researcher/planner consume this verbatim; OPEN items E1-E4 are
captain-ruled at GATE A, not silently resolved.*
