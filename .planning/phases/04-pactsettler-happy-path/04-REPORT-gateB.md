# WP-EVM-04 GATE B Report

**Date:** 2026-05-18
**Branch:** feat/arc-protocol-v1
**Status:** AWAITING CAPTAIN APPROVAL — no push, no PR #204 comment

---

## forge build

Clean. Exit 0. Only linting notes (pre-existing, not introduced by WP-04).

---

## forge test

```
Ran 6 test suites in 103.30ms: 89 tests passed, 0 failed, 0 skipped (89 total)
```

Suite breakdown:
- ArcConstants.t.sol: 1 passed
- Deployment.t.sol: 4 passed
- PactRegistryTest: 31 passed (regression gate — all pre-existing WP-02 tests held)
- PactSettlerTest: 19 passed (7 from 04-02 + 6 from 04-03 + 6 new from 04-04)
- PactPoolTest: 19 passed (regression gate — all pre-existing WP-03 tests held)
- FeeValidationTest: 15 passed (regression gate)

**Total prior tests (regression gate):** 70 (83 baseline at 04-03 close, excluding 04-04's 6 new)
Wait — 04-02 added 7, 04-03 added 6, 04-04 added 6 = 19 PactSettlerTest + 70 pre-existing = 89 total. Prior baseline at 04-03 end was 83. 04-04 added 6 new tests (tests 1-4, 9 + ABI-identity = 6). 83 + 6 = 89. All 83 prior tests still pass. Regression gate held.

---

## 9 Ported WP-04 Happy-Path Tests (05-settle-batch.test.ts oracle)

| # | Test Name | Status | Key Assertions (verbatim from 05 oracle) |
|---|-----------|--------|------------------------------------------|
| 1 | test_SingleEventDefaultTreasuryFanOut | PASS | agent=9_990_000, pool_usdc=5_009_000, treasury=1_000, pool.currentBalance=5_009_000, totalCalls=1, totalPremiums=10_000 |
| 2 | test_SingleEventExplicit85_10_5Split | PASS | treasury=10_000, aff=5_000, pool_usdc=5_085_000, agent=9_900_000 |
| 3 | test_BreachRefundsAgentFromPool | PASS | agent=10_049_000, pool_usdc=4_950_900, treasury=100, CallSettled(Settled,refund=50_000,actualRefund=50_000), currentPeriodRefunds=50_000, totalRefunds=50_000 |
| 4 | test_MixedBatch3Endpoints | PASS | agent=29_400_000, ep1.currentBalance=1_090_000, ep2=1_180_000, ep3=1_299_970, treasury=20_030, aff2=10_000 |
| 5 | test_RevokeMarksDelegateFailedAndContinues | PASS | (04-03) DelegateFailed+continue, no funds moved, dedup consumed |
| 6 | test_MinPremiumEdgeRejected | PASS | (04-03) PremiumTooSmall revert |
| 7 | test_DuplicateCallIdRejected | PASS | (04-03) DuplicateCallId revert on replay |
| 8 | test_UnauthorizedSettlerRejected | PASS | (04-03) AccessControlUnauthorizedAccount |
| 9 | test_HappyPathSettledStatusEvent | PASS | CallSettled(Settled(0), refund=50_000, actualRefund=50_000) — ports cr[2]==0, readU64(cr,80)==50_000, readU64(cr,88)==50_000 |

---

## GATE-A Rulings as Implemented

### E1 — OPTION (a): TWO SETTLER_ROLE-gated endpoint-stats hooks on PactRegistry

Split into two distinct functions matching settle_batch.rs's TWO distinct ep.* mutation points:

**HOOK 1: `recordCallAndCapAccrual(bytes16, uint64, bool, uint64) returns (uint64)`**
- Composed BEFORE the fee fan-out in `PactSettler._settleSuccess` (line 163 < fee loop line 175)
- Implements settle_batch.rs:385-414 in exact source order: totalCalls+=1, totalPremiums+=premium, if breach totalBreaches+=1, PERIOD RESET (settle_batch.rs:396-399 — WP-04), payableRefund=intendedRefund (no clamp in WP-04), currentPeriodRefunds+=payableRefund
- Returns payableRefund (== ev.refund in WP-04 happy path; WP-05 returns clamped amount with zero call-site change — additive seam inside hook body)

**HOOK 2: `recordRefundPaid(bytes16, uint64)`**
- Composed AFTER `pool.payout(ev.agent)` + `pool.debitForRefund()` in `PactSettler._settleSuccess` (line 212 > payout line 201)
- Implements settle_batch.rs:493-499: totalRefunds+=actualRefund
- Guarded by `if (actualRefund > 0)` — mirrors Solana only reaching :493-499 inside the paid else branch

**Period reset is WP-04** (D-SPLIT refinement confirmed): settle_batch.rs:396-399 `if now > current_period_start + 3600 { reset }` lives inside `recordCallAndCapAccrual` in PactRegistry, NOT inline in PactSettler. Verified by: `grep "currentPeriodStart" src/PactSettler.sol` returns nothing.

**test_BreachRefundsAgentFromPool** confirms both hooks at correct positions:
- `currentPeriodRefunds == 50_000` (HOOK 1, pre-fan-out accrual) ✓
- `totalRefunds == 50_000` (HOOK 2, post-transfer actual) ✓

### E2 — SETTLER_ROLE gate (04-02)

OZ AccessControl SETTLER_ROLE on PactSettler (3-arg ctor). Deployed PactSettler holds SETTLER_ROLE on BOTH PactPool AND PactRegistry (two-layer grant in setUp). `settleBatch` is `onlyRole(SETTLER_ROLE)`.

### E3 — Single IPactSettler.CallSettled emission per call

Exactly one `IPactSettler.CallSettled` per call (typed enum) on both paths:
- DelegateFailed path: emits with `SettlementStatus.DelegateFailed`, then `continue`
- Settled path: emits with `SettlementStatus.Settled` and real `actualRefund` value
No second `PactEvents.CallSettled` emission anywhere.

**ABI-identity assertion** (`test_CallSettled_ABI_Identity`): both declarations share the same topic0 = `keccak256("CallSettled(bytes16,bytes16,address,uint64,uint64,uint64,uint8,bool,uint32,uint64)")`. "Alias" is literally true. Recorded for WP-06 parity matrix.

### E4 — Dedup-before-premium-in + event-as-truth

`_settledCallIds[ev.callId] = true` set at line 92, BEFORE the premium-in `try/catch` at line 101. DelegateFailed events consume the callId and are not retryable. Verified by `test_RevokeMarksDelegateFailedAndContinues` assertion (d).

---

## WP-05 Clean Additive Seams Left

Three WP-05 clamp decisions NOT implemented; clean insertion points left:

1. **ExposureCapClamped** (settle_batch.rs:400-408): seam comment between period reset and currentPeriodRefunds accrual inside `recordCallAndCapAccrual`. WP-05 inserts `capRemaining` saturating-sub + clamp branch here; `payableRefund` return drives the refund transfer. Zero WP-04 rewrite.

2. **PoolDepleted** (settle_batch.rs:462-469): EMPTY `if (ps.currentBalance < payableRefund) { }` block in `PactSettler._settleSuccess`. WP-05 sets `status=PoolDepleted` and `actualRefund=0` here. The transfer is in the `else` — WP-05 turns this into the pool-sufficient else without rewriting WP-04.

3. **Pause kill-switches**: entirely WP-05; pre-loop + per-event. Not touched.

**Grep confirmation** (scoped to PactSettler.sol — PactRegistry.sol period reset is intentional per D-SPLIT):
- `grep "SettlementStatus.PoolDepleted\|SettlementStatus.ExposureCapClamped\|BatchTooLarge\|currentPeriodStart\|protocolPaused" src/PactSettler.sol` → no matches ✓
- `grep "recordSettlement" src/PactSettler.sol` → no matches ✓

---

## N-A-ON-EVM List (for WP-06 parity matrix)

These Solana behaviors have no EVM equivalent (per D-LOCK-5 / design spec §4):

| N-A Item | Solana mechanism | EVM disposition |
|----------|-----------------|-----------------|
| `deriveCallRecord` PDA | PDA derivation from call_id seeds | N/A: no PDAs on EVM; dedup via `mapping(bytes16=>bool)` |
| `getAccountData` CallRecord existence | PDA account data read | N/A: event-as-truth (GATE-A E4); `_settledCallIds` mapping |
| `cr[2]` / `readU64(cr,80)` / `readU64(cr,88)` byte reads | Raw byte-offset deserialization of CallRecord | N/A: ported to `vm.expectEmit` on `CallSettled.{status,refund,actualRefund}` |
| `is_data_empty()` dedup check | PDA account empty check | N/A: `_settledCallIds[callId]` mapping check |
| SPL Token delegate pre-flight | `token::accessor::delegate + delegated_amount` | N/A: ERC-20 `allowance` checked implicitly by `transferFrom` |
| `SettlementAuthority` PDA signer | CPI signer PDA for pool vault transfers | N/A: `onlyRole(SETTLER_ROLE)` AccessControl |
| `pool_vault` ATA binding | Dedicated SPL token ATA per pool | N/A: single `PactPool` contract holds all USDC |
| `NotEnoughAccountKeys` / `InvalidSeeds` | Solana account validation | N/A: no accounts/PDAs on EVM |

---

## Disabled Gates Note

Per captain direction (GATE-A Config Flag ruling): Nyquist/security GSD gates are intentionally DISABLED for WP-04. The ported LiteSVM oracle + strict TDD is the validation contract for this phase. Recorded for downstream phases:
- **WP-05** (settler hardening): SHOULD enable a settlement threat-model/adversarial pass (PoolDepleted, ExposureCapClamped, pause kill-switches, BatchTooLarge)
- **WP-06** (fuzz/gas/parity matrix): covers statistical adequacy and the formal parity matrix

---

## Contamination Check

`git status --porcelain` output: `?? .claude/pr-reviews/`

Only expected untracked directory present. No `CLAUDE.md` ` M`. No `.claude/skills/pact/` modification. Tree clean.

---

## Commit SHAs (WP-EVM-04)

| Plan | Commit | Description |
|------|--------|-------------|
| 04-02 | bd22432 | refactor: PactSettler AccessControl SETTLER_ROLE (E2) |
| 04-02 | 0b01648 | feat: split E1 endpoint-stats hooks (E1) |
| 04-02 | 566e695 | test: PactSettler.t.sol harness (E1xE2) |
| 04-03 | 525e6a1 | test RED: 4 guard/auth tests |
| 04-03 | ce1c281 | feat GREEN: per-event guards + settler gate |
| 04-03 | 3abe9c0 | test RED: 2 dedup/DelegateFailed tests |
| 04-03 | 9602147 | feat GREEN: dedup mapping + premium-in try/catch |
| 04-04 | f46a0b6 | test RED: default-10% fan-out economic assertions |
| 04-04 | 8cc7b1a | feat GREEN: settleBatch full economic loop |
| 04-04 | 8592faf | test: remaining 05 happy-path scenarios; 9/9 green |

---

## STOPPED

Execution halted pending captain GATE B approval.
- No `git push` performed.
- No PR #204 comment posted.
- Report at: `.planning/phases/04-pactsettler-happy-path/04-REPORT-gateB.md`
- Next action: captain reviews this report, approves or requests changes.
  Push and PR #204 comment happen ONLY after captain approval.
