---
phase: 04-pactsettler-happy-path
plan: 02
subsystem: protocol-evm-v1
tags: [evm, settler, registry, access-control, tdd, parity]
dependency_graph:
  requires: [04-01]
  provides: [PactSettler-AccessControl, PactRegistry-E1-hooks, PactSettler-harness]
  affects: [04-03, 04-04]
tech_stack:
  added: [OZ-AccessControl-on-PactRegistry, OZ-AccessControl-on-PactSettler]
  patterns: [SETTLER_ROLE-gated-hooks, split-ep-mutation-points, WP-05-seam-comment]
key_files:
  created:
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
  modified:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/src/PactRegistry.sol
    - packages/program-evm/protocol-evm-v1/src/interfaces/IPactRegistry.sol
    - packages/program-evm/protocol-evm-v1/test/Deployment.t.sol
decisions:
  - "E2 RULED: PactSettler 3-arg ctor + OZ AccessControl SETTLER_ROLE; DEFAULT_ADMIN_ROLE -> registry.authority(); Deployment.t.sol 3-arg"
  - "E1 RULED OPTION (a): PactRegistry gains AccessControl + SETTLER_ROLE + _ckAdd + two SETTLER_ROLE-gated hooks mirroring settle_batch.rs's two ep.* mutation points"
  - "D-SPLIT REFINED: period reset (settle_batch.rs:396-399) is WP-04 happy-path, implemented in recordCallAndCapAccrual; only cap-clamp/PoolDepleted/pause decisions are WP-05"
  - "Hook SPLIT mandatory: two functions (not one) so 04-04 places each at the exact source mutation position"
  - "WP-05 cap-clamp seam: payableRefund = intendedRefund in WP-04; seam comment between period-reset and currentPeriodRefunds accrual; zero WP-04 rewrite needed"
  - "D1 scope refinement: WP-03 D1 barred PactPool reaching into registry; does NOT bar WP-04 adding its own gated stat-writer (GATE-A E1 condition 4)"
metrics:
  duration: "~30 minutes"
  completed: "2026-05-18"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 4
  tests_added: 7
  tests_total: 77
  tests_regression: 70
---

# Phase 4 Plan 02: WP-EVM-04 Foundation (AccessControl + E1 Hooks + Harness) Summary

PactSettler AccessControl SETTLER_ROLE per GATE-A E2, TWO SETTLER_ROLE-gated
endpoint-stats hooks on PactRegistry per GATE-A E1 mirroring settle_batch.rs's
two distinct ep.* mutation points, shared PactSettler.t.sol harness with E1xE2
two-layer role grant.

## What Was Built

### Task 1: PactSettler AccessControl + SETTLER_ROLE (GATE-A E2)

Refactored `PactSettler` from a 4-arg ctor + plain `address public settler`
storage var to OZ `AccessControl` + `SETTLER_ROLE` per the GATE-A E2 ruling:

- `contract PactSettler is IPactSettler, AccessControl`
- `bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE")`
- 3-arg ctor `(address usdc_, address registry_, address pool_)`: drops
  `address settler_`; `_grantRole(DEFAULT_ADMIN_ROLE, IPactRegistry(registry_).authority())`
  mirrors PactPool.sol:35 exactly
- `settleBatch` is `onlyRole(SETTLER_ROLE)`; still reverts `NOT_IMPLEMENTED`
  (plans 03/04 fill it)
- `Deployment.t.sol test_DeployPactSettler` updated to the 3-arg ctor with a
  real `PactRegistry` + `PactPool` (same pattern as `test_DeployPactPool`)

### Task 2: TWO SETTLER_ROLE-gated endpoint-stats hooks on PactRegistry (GATE-A E1)

**PURE ADDITIVE** extension of the committed WP-02 `PactRegistry`:

- `contract PactRegistry is IPactRegistry, PactEvents, AccessControl`
- `bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE")` (same
  literal as PactPool.sol:22)
- Constructor: single additive line `_grantRole(DEFAULT_ADMIN_ROLE, authority_)`
  per E1 condition (1); all other ctor lines byte-identical
- `_ckAdd` mirrors PactPool.sol:79-84 verbatim (`unchecked { c = a + b }; if
  (c < a) revert ArithmeticOverflow()`)
- **HOOK 1** `recordCallAndCapAccrual(bytes16,uint64,bool,uint64) external
  onlyRole(SETTLER_ROLE) returns (uint64 payableRefund)` — settle_batch.rs:385-414
  in EXACT source order:
  - `:385` `ep.totalCalls = _ckAdd(ep.totalCalls, 1)`
  - `:386-389` `ep.totalPremiums = _ckAdd(ep.totalPremiums, premium)`
  - `:390-395` `if (breach) ep.totalBreaches = _ckAdd(ep.totalBreaches, 1)`
  - `:396-399` **PERIOD RESET** (WP-04, D-SPLIT refinement): `if (uint64(block.timestamp) > ep.currentPeriodStart + 3600) { ep.currentPeriodStart = uint64(block.timestamp); ep.currentPeriodRefunds = 0; }`
  - `payableRefund = intendedRefund` (WP-04: NO clamp)
  - **WP-05 cap-clamp SEAM comment** (clean additive insertion point — NOT implemented)
  - `:409-414` `if (payableRefund > 0) { ep.currentPeriodRefunds = _ckAdd(ep.currentPeriodRefunds, payableRefund); }`
  - `return payableRefund`
- **HOOK 2** `recordRefundPaid(bytes16,uint64) external onlyRole(SETTLER_ROLE)`
  — settle_batch.rs:493-499: `ep.totalRefunds = _ckAdd(ep.totalRefunds, actualRefund)`
- `IPactRegistry.sol` declares both hooks additively (no struct change)

**D1 scope refinement note:** WP-03 ruling D1 ("NO modification of committed
WP-02 PactRegistry") is refined, not contradicted: D1 barred PactPool reaching
into the registry beyond a read-only reference. It does NOT bar WP-04 adding
its own SETTLER_ROLE-gated endpoint-stats writer to PactRegistry, which is where
design-spec §6 places EndpointConfig state. Recorded per GATE-A E1 condition (4).

### Task 3: PactSettler.t.sol shared harness (E1xE2 two-layer grant)

`test/PactSettler.t.sol` — shared setUp + helpers mirroring helpers.ts:

- `setUp()`: deploys usdc/reg/pool/settler; caches role constants BEFORE any
  `vm.prank`; **E1xE2 TWO-LAYER GRANT**: `pool.grantRole(poolSettlerRole, address(settler))` AND `reg.grantRole(regSettlerRole, address(settler))` AND `settler.grantRole(settlerRole, settlerSigner)`
- `_register(bytes16 slug)`: `reg.registerEndpoint(slug, 500, 0, 5000, 1000, 5_000_000, false, 0, none)` — helpers.ts defaults exactly
- `_registerWithRecipients(bytes16, FeeRecipient[8], uint8)`: explicit recipients
- `_fundPool(bytes16, uint64)`: mint + approve + topUp (mirrors fundPoolDirect)
- `_provisionAgent(address, uint64, uint64)`: mint + `approve(address(settler), ...)` — settler is the ERC-20 spender (NOT the pool), per §4#5
- `_makeEvent(...)`: builds `IPactSettler.SettlementEvent` structs

## RED Evidence (TDD requirement)

### Task 1 RED (confirmed before any src change)

```
Compiler run failed:
Error (6160): Wrong argument count for function call: 3 arguments given but expected 4.
  --> test/PactSettler.t.sol:46:19:
   |
46 |         settler = new PactSettler(address(usdc), address(reg), address(pool));

Error (9582): Member "SETTLER_ROLE" not found or not visible after argument-dependent lookup in contract PactRegistry.
  --> test/PactSettler.t.sol:50:28:
   |
50 |         regSettlerRole   = reg.SETTLER_ROLE();
```

Two distinct failures: (1) PactSettler still had the 4-arg ctor; (2) PactRegistry
had no `SETTLER_ROLE`. Both exactly match what the plan predicted.

### Task 2 RED (confirmed before any src change)

```
Compiler run failed:
Error (9582): Member "SETTLER_ROLE" not found or not visible after argument-dependent lookup in contract PactRegistry.
  --> test/PactSettler.t.sol:56:27:
   |
56 |         regSettlerRole  = reg.SETTLER_ROLE();
```

`recordCallAndCapAccrual` and `recordRefundPaid` were also absent from
PactRegistry — the full set of Task 2 RED failures is:
- `Member "SETTLER_ROLE" not found` on PactRegistry
- `Member "recordCallAndCapAccrual" not found` (would have followed after SETTLER_ROLE was added)
- `Member "recordRefundPaid" not found`

Confirmed RED before implementing PactRegistry changes.

## GREEN Evidence

All 77 tests pass, zero failures:

```
Ran 6 test suites in 114.29ms: 77 tests passed, 0 failed, 0 skipped (77 total tests)
```

Breakdown:
- `PactSettlerTest`: 7 new tests (Tasks 1+2+3) — all PASS
- `PactRegistryTest`: 31 pre-existing WP-02 tests — all PASS (regression gate held)
- `PactPoolTest`: 19 pre-existing WP-03 tests — all PASS
- `FeeValidationTest`: 15 pre-existing tests — all PASS
- `ArcConstants.t.sol`: 4 pre-existing — all PASS
- `DeploymentTest`: 4 tests (including updated test_DeployPactSettler) — all PASS

New PactSettlerTest tests:
1. `test_Deploy_WiresSettlerRoleAndAdmin` — E2 role wiring
2. `test_EndpointStats_RecordCallAccumulates` — HOOK 1 + HOOK 2 accumulation
3. `test_EndpointStats_RecordCallRejectsNonSettler` — HOOK 1 role gate
4. `test_EndpointStats_RecordRefundPaidRejectsNonSettler` — HOOK 2 role gate
5. `test_EndpointStats_PeriodReset` — settle_batch.rs:396-399 period reset
6. `test_EndpointStats_WithinWindowAccumulates` — in-window accumulation
7. `test_EndpointStats_RecordRefundPaidAccumulates` — HOOK 2 independent accumulation

## Deviations from Plan

None — plan executed exactly as written. The WP-05 cap-clamp seam comment contains
the keywords `ExposureCapClamped`, `saturating`, `capRemaining` (as documented
in the plan's acceptance criteria note: "the only WP-05 token in PactRegistry.sol
is that seam comment"). The grep check for absence of WP-05 logic correctly
identifies only commented seam text, not live code — this is the intended state.

## WP-05 Seams Left Clean

Three WP-05 clamp decisions are NOT implemented; clean additive seams left:

1. **ExposureCapClamped** (settle_batch.rs:400-408): seam comment between the
   period reset and the `currentPeriodRefunds` accrual inside
   `recordCallAndCapAccrual`. WP-05 inserts the `capRemaining` saturating-sub
   + clamp branch here; `payableRefund` return drives the refund transfer.
   Zero WP-04 rewrite needed.

2. **PoolDepleted** (settle_batch.rs:462-469): composed in 04-04 settleBatch,
   not in the registry hooks.

3. **Pause kill-switches**: entirely WP-05; pre-loop + per-event.

## Known Stubs

None. All new functions are fully implemented per the GATE-A rulings.
`settleBatch` reverts `NOT_IMPLEMENTED` — this is the intentional WP-04
state (plans 03/04 implement the body); it is not a stub blocking this plan's goal.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or trust-boundary
schema changes introduced beyond what the GATE-A ruling explicitly sanctioned
(SETTLER_ROLE-gated write path to EndpointConfig, symmetric to existing PactPool
pattern). WP-05 threat-model/adversarial pass will cover the settlement path.

## Self-Check

Files created/modified exist:
- `packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol` — FOUND
- `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` — FOUND (modified)
- `packages/program-evm/protocol-evm-v1/src/PactRegistry.sol` — FOUND (modified)
- `packages/program-evm/protocol-evm-v1/src/interfaces/IPactRegistry.sol` — FOUND (modified)
- `packages/program-evm/protocol-evm-v1/test/Deployment.t.sol` — FOUND (modified)

Commits exist:
- `bd22432` refactor(protocol-evm-v1): PactSettler AccessControl SETTLER_ROLE per GATE-A E2 (WP-EVM-04)
- `0b01648` feat(protocol-evm-v1): split E1 endpoint-stats hooks... per GATE-A E1 (WP-EVM-04)
- `566e695` test(protocol-evm-v1): PactSettler.t.sol shared harness mirroring helpers.ts (WP-EVM-04)

## Self-Check: PASSED
