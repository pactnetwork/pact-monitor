# Roadmap: Pact Network — Arc EVM Parity Port

## Overview

Port the Solana on-chain program `pact-network-v1-pinocchio` to Circle Arc
(EVM L1, testnet target) at full behavioral parity. The Solana program plus its
10 LiteSVM test files are the authoritative behavioral spec. Behavioral port,
EVM-idiomatic mechanism: every Solana feature reproduced, all economic math
bit-identical; documented mechanism divergences in design-spec §4 only.
Phase numbers equal work-package numbers (Phase N == WP-EVM-0N).

## Phases

- [x] **Phase 1: WP-EVM-01 Scaffold** - Foundry package + interface scaffold (PR #204)
- [x] **Phase 2: WP-EVM-02 Registry/Fee/Errors/Events** - errors, events, ArcConfig, PactRegistry, FeeValidation + ported registry/treasury/config tests
- [x] **Phase 3: WP-EVM-03 PactPool** - full pool logic + settler-gated hooks + ported pool tests
- [x] **Phase 4: WP-EVM-04 PactSettler Happy Path** - settleBatch happy path + ported settle-batch happy tests (completed 2026-05-18)
- [ ] **Phase 5: WP-EVM-05 PactSettler Hardening** - clamps, kill switches, batch-limit edges + ported pause/exposure tests
- [ ] **Phase 6: WP-EVM-06 TS Client + Suite + Parity Matrix** - protocol-evm-v1-client, fuzz/gas suite, parity matrix doc
- [ ] **Phase 7: WP-EVM-07 Deploy** - deploy script + Arc testnet deploy + arcscan verify (deferred, separate cycle)

## Phase Details

### Phase 1: WP-EVM-01 Scaffold
**Goal**: Foundry package and interface scaffold landed on `feat/arc-protocol-v1`.
**Depends on**: Nothing
**Requirements**: SCAFFOLD-01
**Success Criteria** (what must be TRUE):
  1. `forge build` clean on the scaffold.
**Plans**: Complete (not GSD-tracked)

### Phase 2: WP-EVM-02 Registry/Fee/Errors/Events
**Goal**: Registry/fee/errors/events layer ported at parity with ported tests green.
**Depends on**: Phase 1
**Requirements**: ERR-01, FEE-01, FEE-02, FEE-03, REG-01
**Success Criteria** (what must be TRUE):
  1. 30 PactError custom errors; FeeValidation mirrors fee.rs; PactRegistry register/update/pause logic at parity; ported tests green.
**Plans**: Complete (plan-doc-driven, not GSD-tracked)

### Phase 3: WP-EVM-03 PactPool
**Goal**: PactPool full logic + settler-gated hooks at parity with ported pool tests green.
**Depends on**: Phase 2
**Requirements**: POOL-01, POOL-02, POOL-03
**Success Criteria** (what must be TRUE):
  1. topUp/balanceOf ported from top_up_coverage_pool.rs; settler hooks (creditPremium/debitForFees/debitForRefund/payout) defined + isolation-tested; ArithmeticOverflow bidirectional; ported `01-pool.test.ts` green.
**Plans**: Complete (plan-doc-driven, not GSD-tracked; design decisions D1-D6 captain-approved)

### Phase 4: WP-EVM-04 PactSettler Happy Path
**Goal**: `PactSettler.settleBatch` happy-path per-event loop ported bit-identically from `settle_batch.rs`, composing the WP-03 SETTLER_ROLE pool hooks, with the happy-path subset of `tests/05-settle-batch.test.ts` ported to Foundry and green. Clamps, kill switches, and batch-limit edges are explicitly OUT (deferred to WP-EVM-05).
**Depends on**: Phase 3
**Requirements**: SET-01, SET-02, SET-03, SET-04, SET-05, SET-06, SET-07, SET-08
**Success Criteria** (what must be TRUE):
  1. `settleBatch` callable only by the settler role; unauthorized caller reverts (mirrors `05` "unauthorized settler rejected").
  2. Per event: premium-in via `transferFrom(agent, pool, premium)`; on failure the event is marked `DelegateFailed`, no funds move, the batch continues (mirrors `05` "revoke between events").
  3. Per event: `premium < MIN_PREMIUM` reverts `PremiumTooSmall`; `timestamp > block.timestamp` reverts `InvalidTimestamp`; `feeRecipientCountHint != stored count` reverts `RecipientCoverageMismatch`.
  4. Per event: repeated `callId` reverts `DuplicateCallId` (mapping(bytes16=>bool)).
  5. On success: pool credited gross premium; fee fan-out pays each recipient `premium * bps / 10000` (integer floor), pool keeps the residual; balances bit-identical to the Solana assertions in `05` (default-10%, explicit 85/10/5, mixed-3-endpoint, breach-refund cases).
  6. On breach with sufficient pool + within cap: refund flows pool→agent for the full intended amount; status `Settled`; endpoint and pool stats updated with identical arithmetic and ordering to `settle_batch.rs`.
  7. One `CallSettled` event emitted per call carrying premium/refund/actualRefund/status/breach/latencyMs/timestamp.
  8. Ported happy-path subset of `tests/05-settle-batch.test.ts` is green under `forge test`; existing 70 tests stay green.
**Plans**: 4 plans
- [x] 04-01-PLAN.md — GATE-A decision record: E1-E4 captain rulings (no Solidity)
- [x] 04-02-PLAN.md — Foundation: PactSettler AccessControl (E2) + endpoint-stats path (E1) + test harness
- [x] 04-03-PLAN.md — Per-event guards + dedup + premium-in try/catch -> DelegateFailed (SET-01..04)
- [x] 04-04-PLAN.md — Pool credit + fee fan-out + breach refund + CallSettled + 9 ported tests + GATE B (SET-05..08)

### Phase 5: WP-EVM-05 PactSettler Hardening
**Goal**: Exposure-cap clamp, pool-depleted clamp, protocol/endpoint kill switches, batch-limit edges + ported `06/07/09/10` and the clamp/kill-switch subset of `05`, as pure additive port edits at the four WP-04 seams (no WP-04 reorder/rewrite; 90/90 regression preserved).
**Depends on**: Phase 4
**Requirements**: SET-09, SET-10, SET-11, SET-12
**Success Criteria** (what must be TRUE):
  1. PoolDepleted + ExposureCapClamped clamps (pool-then-cap final-status precedence: PoolDepleted > ExposureCapClamped > Settled), hourly rolling window reset asserted end-to-end, protocol-paused fast-revert before any per-event work, endpoint-paused per event at the LOCKED D-LOCK-PREC slot, BatchTooLarge edge (50 OK / 51 rejects); ported pause/exposure tests green; full WP-02/03/04/05 forge regression green with the WP-04 90/90 baseline preserved.
**Plans**: 6 plans
- [x] 05-01-PLAN.md — GATE-A decision record: captain P1/P3 rulings + adversarial-pass decision (no Solidity; gates the phase)
- [x] 05-02-PLAN.md — Pre-loop ProtocolPaused fast-revert + BatchTooLarge edge (SET-11, SET-12; P3-dependent)
- [ ] 05-03-PLAN.md — Per-event EndpointPaused at the LOCKED D-LOCK-PREC slot (SET-11)
- [ ] 05-04-PLAN.md — Exposure-cap clamp + P1 ExposureCapClamped inference + 1-hour-reset (SET-10; P1-dependent)
- [ ] 05-05-PLAN.md — Pool-depleted clamp + D-LOCK-CLAMP-ORDER precedence + no-rollback (SET-09)
- [ ] 05-06-PLAN.md — Test port completion + N-A matrix + full WP-02/03/04/05 regression + GATE B

### Phase 6: WP-EVM-06 TS Client + Suite + Parity Matrix
**Goal**: `@pact-network/protocol-evm-v1-client` (viem) + consolidated fuzz/gas suite + parity-matrix doc + formal spec-defect corrections.
**Depends on**: Phase 4
**Requirements**: CLIENT-01, MATRIX-01
**Success Criteria** (what must be TRUE):
  1. Client builds and mirrors protocol-v1-client modules; full suite + fuzz green; parity matrix marks every behavior IDENTICAL / OPTIMIZED-DIVERGENCE / N-A-on-EVM.
**Plans**: TBD

### Phase 7: WP-EVM-07 Deploy
**Goal**: Deploy script + Arc testnet deploy + arcscan verify.
**Depends on**: Phase 5, Phase 6
**Requirements**: DEPLOY-01
**Success Criteria** (what must be TRUE):
  1. Deployed to Arc testnet and verified on arcscan. (Deferred — separate cycle, NOT part of the parity effort.)
**Plans**: TBD
