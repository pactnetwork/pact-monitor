# Requirements: Pact Network — Arc EVM Parity Port

**Defined:** 2026-05-18
**Core Value:** Bit-identical behavioral parity with the Solana
`pact-network-v1-pinocchio` program; the 10 LiteSVM test files are the oracle.

Derived from design-spec §3 (parity invariants) and §9 (success criteria).
Only the WP-EVM-04-relevant categories are itemised in detail; earlier phases
are complete and later phases carry placeholder IDs for roadmap coverage.

## Scaffold (Phase 1 — complete)

- [x] **SCAFFOLD-01**: Foundry package + interfaces compile (`forge build`).

## Registry / Fee / Errors / Events (Phase 2 — complete)

- [x] **ERR-01**: 30 PactError variants → named Solidity custom errors.
- [x] **FEE-01**: `fee.rs` validation ported (Treasury exactly-one, bps caps, dup/post-sub).
- [x] **FEE-02**: §4#7 affiliate guard (non-zero, not duplicate, not aliasing Treasury).
- [x] **FEE-03**: `validateDefaultTemplate` separate from `validate` (Option B).
- [x] **REG-01**: register/update/pause/protocol-config parity; ported tests green.

## Pool (Phase 3 — complete)

- [x] **POOL-01**: `topUp`/`balanceOf` ported from `top_up_coverage_pool.rs` (D1-D5).
- [x] **POOL-02**: settler-gated hooks defined + isolation-tested (D4, §4#5).
- [x] **POOL-03**: bidirectional `ArithmeticOverflow` (D6); ported `01-pool.test.ts` green.

## Settler — Happy Path (Phase 4 — WP-EVM-04)

Source of truth: `src/instructions/settle_batch.rs`. Oracle: happy-path
subset of `tests/05-settle-batch.test.ts`.

- [x] **SET-01**: `settleBatch` is gated by the settler role; an unauthorized
  caller reverts (`05` "unauthorized settler rejected"). Mirrors
  `settle_batch.rs:95-128` settler-signer / `SettlementAuthority` check
  (design §4#5 — OZ AccessControl `SETTLER_ROLE`).
- [x] **SET-02**: Premium-in via `transferFrom(agent, pool, premium)` wrapped
  in try/catch; on failure the event is marked `DelegateFailed`, no funds
  move, the batch continues (`05` "revoke between events"; §4#1;
  `settle_batch.rs:295-355`).
- [x] **SET-03**: Per-event guards: `premium < MIN_PREMIUM` → `PremiumTooSmall`;
  `timestamp > now` → `InvalidTimestamp`; `feeRecipientCountHint != stored
  feeRecipientCount` → `RecipientCoverageMismatch`
  (`settle_batch.rs:158-166,213-215`).
- [x] **SET-04**: Repeated `callId` → `DuplicateCallId` via
  `mapping(bytes16 => bool)` (design §3 dedup; `settle_batch.rs:194-196`).
- [x] **SET-05**: On success, pool credited gross premium and fee fan-out pays
  each recipient `premium * bps / 10000` (integer floor, `uint64`
  truncation), pool retains the residual; balances bit-identical to the
  Solana assertions in the `05` default-10% / explicit-85-10-5 /
  mixed-3-endpoint cases (`settle_batch.rs:357-453`; spec §3 fee math).
- [x] **SET-06**: On breach with sufficient pool liquidity and within the
  exposure cap, refund flows pool→agent for the full intended amount; status
  `Settled`; `actualRefund == intended` (`05` "breach refunds" + "happy path:
  settlement_status = Settled"; `settle_batch.rs:455-502`).
- [x] **SET-07**: Stats accounting — pool `currentBalance/totalPremiums/
  totalRefunds` and endpoint `totalCalls/totalBreaches/totalPremiums/
  totalRefunds` updated with identical arithmetic and ordering to
  `settle_batch.rs` (spec §3 stats accounting; composes WP-03 pool hooks +
  the endpoint-stats write path resolved at GATE A).
- [x] **SET-08**: Exactly one `CallSettled` event per call carrying
  `premium/refund/actualRefund/status/breach/latencyMs/timestamp` (design
  §4#3 — events are the indexer truth source; EVM has no `CallRecord`).

## Settler — Hardening (Phase 5 — placeholders)

- [ ] **SET-09**: Pool-depleted clamp → `PoolDepleted` status.
- [ ] **SET-10**: Exposure-cap clamp → `ExposureCapClamped`; hourly window.
- [x] **SET-11**: Protocol-paused fast-revert; endpoint-paused per event.
- [ ] **SET-12**: `BatchTooLarge` edge (batch ≤ MAX_BATCH_SIZE).

## Client / Matrix / Deploy (Phases 6-7 — placeholders)

- [ ] **CLIENT-01**: `@pact-network/protocol-evm-v1-client` mirrors protocol-v1-client.
- [ ] **MATRIX-01**: Parity-matrix doc + formal spec-defect corrections.
- [ ] **DEPLOY-01**: Arc testnet deploy + arcscan verify (deferred).
