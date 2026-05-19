---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: completed
last_updated: "2026-05-19T11:52:00.000Z"
last_activity: 2026-05-19
progress:
  total_phases: 7
  completed_phases: 7
  total_plans: 10
  completed_plans: 10
  percent: 100
---

# Project State

## Project Reference

**Core value:** Behavioral-parity port of the Solana `pact-network-v1-pinocchio`
on-chain program to Circle Arc (EVM L1), driven by the 10 LiteSVM test files as
the parity oracle. This is a PORT, not a redesign.
**Current focus:** ARC EVM TRACK COMPLETE (WP-EVM-02..07). The Solana
pact-network-v1 program is ported to EVM at behavioral parity AND live on
Arc Testnet with verified source. Track closed; no further crew.

## Current Position

Phase: 7 — COMPLETE
Plan: WP-EVM-07 authored-at-turn, GATE A + GATE B captain-APPROVED
Status: ARC EVM TRACK COMPLETE — deploy + arcscan verify done 2026-05-19
Last activity: 2026-05-19
WP-EVM-07 deployed the LOCKED WP-05/06 contracts (ZERO contract change) to
Arc Testnet (chain 5042002) and verified all 3 on arcscan:
  - PactRegistry: `0x056BAC33546b5b51B8CF6f332379651f715B889C`
  - PactPool: `0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE`
  - PactSettler: `0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f`
check:abi PASS both passes (deployed bytecode ABI == committed client ABI);
5/5 read-only smoke green; C1/C2 as-deployed (authority = treasury =
deployer EOA, empty default fee template, maxTotalFeeBps 3000). arcscan
verified via `--verifier blockscout` (Arc 5042002 not in forge's etherscan
chain registry). Commits 46d2ab9 + 838c573.

Progress: WP-01 ✓ · WP-02 ✓ · WP-03 ✓ · WP-04 ✓ · WP-05 ✓ · WP-06 ✓ ·
WP-07 ✓ COMPLETE (GATE A+B approved) — ARC EVM TRACK CLOSED

Carried non-blocking items (documented, NOT WP-07-fixed):
- C2 mainnet-hardening: split treasuryVault off the deployer EOA (real
  Safe/multisig) before any mainnet deploy — fresh deploy, no migration,
  treasuryVault has no setter.
- Pre-existing TS18048 x17 in `protocol-evm-v1-client/__tests__/encode.test.ts`
  (a WP-06 artifact, confirmed empty git diff vs 07a79be; vitest 41/41 green).
  A future hygiene cycle, deliberately not touched (file-scoped discipline).

## Decisions (WP-EVM-05 plan 05-06)

- **05-06 PORT inventory**: All 15 PORT rows confirmed green via 05-02..05-05 + WP-02 — zero gaps, no new Foundry tests needed in 05-06. 07:25 two-sub-case coverage confirmed by test_ExposureCap_CumulativeClampAcrossBatches (batch-1 Settled under-cap + batch-2 ExposureCapClamped over-cap + batch-3 saturatingSub=0).

- **05-06 N-A matrix**: 05-NA-MATRIX.md created with 7 N-A-ON-EVM rows (09:47/78/144/172, 10:94/128, D-LOCK-EXPCAP-NA), P3 OPTIMIZED-DIVERGENCE corner documentation, bounded adversarial-pass review (3 vectors, all CLEAN), and PORT coverage summary. All 4 WP-02 surviving-invariant tests confirmed PASS.

- **05-06 adversarial-pass vectors**: V1 cross-agent cap saturation/saturatingSub=0 boundary — CLEAN (already tested by 05-04 third batch); V2 empty-batch pause-bypass — CLEAN (protocolPaused fires pre-loop); V3 reentrancy via protocolPaused()/pool hooks — CLEAN (no external calls on PoolDepleted path; dedup SET before premium-in protects).

- **05-06 GATE B regression**: forge build clean; forge test 102/102 passed, 0 failed. test_DuplicateCallIdPrecedesRecipientCoverageMismatch PASS. WP-04 90/90 baseline preserved. Working tree uncontaminated. No push, no PR comment. GATE B awaiting captain.

- **05-04 Rule 3 flag for captain**: stack-too-deep inline of intendedRefundAfterCap -> ev.refund in _settleSuccess is provably parity-neutral (settle_batch.rs:380 seeds intended = refund_lamports = ev.refund; P1 predicate preserved verbatim). Flagged for captain ratification at GATE B.

## Decisions (WP-EVM-05 plan 05-05)

- **05-05 SET-09 PoolDepleted clamp (seam 2)**: filled empty `if (ps.currentBalance < payableRefund) {}` in `_settleSuccess` with `status = SettlementStatus.PoolDepleted; actualRefund = 0;`. Ports `settle_batch.rs:462-469`. Executes AFTER the 05-04 ExposureCapClamped inference — PoolDepleted naturally overwrites (D-LOCK-CLAMP-ORDER final-status precedence: PoolDepleted > ExposureCapClamped > Settled). WP-04 else branch byte-identical; recordRefundPaid guard (`if (actualRefund > 0)`) correctly skips; no currentPeriodRefunds rollback (P1(b)).

- **05-05 pool-seed accounting for strict-< test**: pool net = seed + creditPremium - debitForFees must be strictly less than the clamped payableRefund for the PoolDepleted branch to fire. For cap=1000/premium=1000/fee=100: seed+900 < 1000 → seed must be 0 (unfunded). Seeding 100 gives net=1000 which fails the strict-< check — the else branch fires erroneously.

- **05-05 forge result**: 102/102 green (100 prior + 2 new PoolDepleted tests). test_DuplicateCallIdPrecedesRecipientCoverageMismatch PASS.

## Decisions (WP-EVM-05 plan 05-04)

- **05-04 SET-10 ExposureCapClamped (seam 1)**: cap clamp inserted in `recordCallAndCapAccrual` between period reset and `currentPeriodRefunds` accrual (PactRegistry.sol). Ports `settle_batch.rs:400-408`. Ternary saturatingSub parity (no underflow). Clamped `payableRefund` returned to UNCHANGED `_settleSuccess` call site (P1 seam pin).

- **05-04 P1 inference in _settleSuccess**: `SettlementStatus status = SettlementStatus.Settled;` local introduced after `recordCallAndCapAccrual` call, BEFORE pool-balance check. `if (payableRefund < ev.refund) { status = ExposureCapClamped; }` -- provably equivalent to Solana :407 (captain-ratified P1 mechanism). Emit uses `status` local (not hardcoded Settled). D-LOCK-CLAMP-ORDER satisfied: ExposureCapClamped set before pool-balance check so PoolDepleted (05-05) can overwrite it.

- **05-04 Rule 3 stack-too-deep fix**: inlined `intendedRefundAfterCap` as `ev.refund` at the call site to free one stack slot. Semantically identical (`settle_batch.rs:380` seeds `intended = refund_lamports == ev.refund`). P1 predicate becomes `payableRefund < ev.refund` -- equivalent. No parity impact.

- **05-04 Adversarial vector 1 tested**: `test_ExposureCap_CumulativeClampAcrossBatches` includes third batch where `currentPeriodRefunds >= exposureCap` -> `cap_remaining=0` -> all clamps to 0 (ExposureCapClamped, actualRefund=0). GATE-A adversarial pass vector 1 covered.

- **05-04 forge result**: 100/100 green (97 prior + 3 new exposure-cap tests). test_DuplicateCallIdPrecedesRecipientCoverageMismatch PASS.

## Decisions (WP-EVM-05 plan 05-03)

- **05-03 SET-11 EndpointPaused per-event**: `if (ep.paused) revert EndpointPaused();` inserted at D-LOCK-PREC slot — after dedup READ (:84) and getEndpoint, before RecipientCoverageMismatch. Ports `settle_batch.rs:209`. Pure additive; only WP-04 placeholder comment removed. 3 new tests; 97/97 forge green. LOCKED test `test_DuplicateCallIdPrecedesRecipientCoverageMismatch` still GREEN.

## Decisions (WP-EVM-05 plan 05-02)

- **05-02 SET-11 ProtocolPaused**: `if (registry.protocolPaused()) revert ProtocolPaused();` inserted as FIRST statement in `settleBatch` body, before `BatchTooLarge` and the per-event loop. Ports `settle_batch.rs:99-115`. Additive only; zero WP-04 lines deleted.

- **05-02 SET-12 BatchTooLarge**: `if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();` inserted after pause gate, before loop. Strictly greater: 50 OK, 51 rejects. Ports `settle_batch.rs:132-135`.

- **05-02 P3 OPTIMIZED-DIVERGENCE confirmed**: authorized-settler+paused paths tested (4 new tests GREEN); unauthorized+paused corner intentionally diverges — EVM returns AccessControlUnauthorizedAccount, documented for WP-06 parity matrix. No WP-04 code reopened.

## Decisions (WP-EVM-04)

- **E1 OPTION (a) RULED**: PactRegistry gains OZ AccessControl + SETTLER_ROLE +
  two SETTLER_ROLE-gated hooks (recordCallAndCapAccrual + recordRefundPaid)
  mirroring settle_batch.rs's two ep.* mutation points (committed in 04-02).

- **E2 RULED**: PactSettler 3-arg ctor + OZ AccessControl SETTLER_ROLE;
  DEFAULT_ADMIN_ROLE -> registry.authority() (committed in 04-02).

- **D1 scope refinement**: WP-03 D1 barred PactPool reaching into registry; WP-04
  adding its own gated stat-writer is a sanctioned additive extension per GATE-A
  E1 condition (4). To be appended to handoff locked-rulings as ruling #8 during
  WP-06 formal-correction pass.

- **04-03 dedup-before-premium-in (E4)**: `_settledCallIds[callId]=true` set at
  line 92, `try IERC20...transferFrom` at line 101 — sentinel before try/catch
  so DelegateFailed events also consume the callId (GATE-A E4, verified from
  settle_batch.rs:243-262).

- **04-03 provisional emit seam**: success path emits `CallSettled(Settled,
  actualRefund=0)` provisionally; plan 04-04 MUST replace with full economic
  emit (one IPactSettler.CallSettled per call, GATE-A E3). REPLACED in 04-04.

- **04-04 stack-too-deep fix**: settleBatch extracted economic body into
  `_settleSuccess` private helper. Mutation order unchanged; parity preserved.

- **04-04 mutation order confirmed**: creditPremium → recordCallAndCapAccrual
  (ep point 1, BEFORE fee fan-out) → fee fan-out → refund transfer →
  recordRefundPaid (ep point 2, AFTER transfer). Mirrors settle_batch.rs exactly.

- **04-04 GATE B APPROVED 2026-05-18**: captain spot-checked the
  dedup-precedence fix (4c2fd86); forge 90/90; gsd-verifier passed (8/8,
  04-VERIFICATION.md); phase 04 marked complete; pushed; PR #204 completion
  comment posted; handoff extended with a WP-EVM-04 OUTCOMES section for the
  fresh WP-05 crew. Guard precedence is now LOCKED:
  guards -> DuplicateCallId(:194) -> RecipientCoverageMismatch(:213) ->
  dedup-SET -> premium-in (WP-05 must preserve).

## Notes

- Branch: `feat/arc-protocol-v1` (single checkout; never touch `main`).
- PR #204 (`pactnetwork/pact-monitor`); WP completion summaries are PR comments.
- Authoritative handoff:
  `docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md` — 7 LOCKED
  rulings + methodology + contamination warning. Treat as settled law; do NOT
  re-derive prior decisions.

- Gate cadence per WP: (1) plan-review gate (GATE A) — author plan, report,
  WAIT for captain approval BEFORE any Solidity; (2) final parity gate (GATE B)
  — after impl + `forge build && forge test` green, report, WAIT, no push / no
  PR comment until approved.

- WP-EVM-04 GATE A RULED 2026-05-18 (see 04-GATE-A-DECISIONS.md). E1=(a):
  PactRegistry gains a SETTLER_ROLE-gated endpoint-stats writer. This REFINES
  WP-03 ruling D1 (NOT a contradiction): D1 barred `PactPool` reaching into
  the registry; it does NOT bar WP-04 adding its own gated stat-writer where
  spec §6 places `EndpointConfig` state. Append to the handoff locked-rulings
  list as ruling #8 during the WP-06 §d formal-correction pass.

- D-SPLIT refinement: the hourly-window PERIOD RESET + `currentPeriodRefunds
  += intendedRefund` are WP-04 happy-path state (in the registry stat hook);
  ONLY the 3 clamp DECISIONS (ExposureCapClamped, PoolDepleted, pause
  kill-switches) are WP-05, layered additively.

- Config: Nyquist/security GSD gates DISABLED for WP-04 (ported LiteSVM oracle
  + strict TDD is the validation contract). WP-05 enables a settlement
  threat-model/adversarial pass; WP-06 fuzz/gas covers statistical adequacy.

- Reporting: gate reports go to `.planning/phases/<phase>/<phase>-REPORT-<gate>.md`
  AND a short `cockpit runtime send pact-network` notice (relay unreliable).
