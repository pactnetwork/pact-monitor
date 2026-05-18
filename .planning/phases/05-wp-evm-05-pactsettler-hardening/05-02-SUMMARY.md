---
phase: 05-wp-evm-05-pactsettler-hardening
plan: "02"
subsystem: program-evm
tags: [solidity, foundry, tdd, settle-batch, protocol-paused, batch-too-large, parity-port]
dependency_graph:
  requires: ["05-01"]
  provides: ["SET-11-protocol-paused-fast-revert", "SET-12-batch-too-large-edge"]
  affects: ["PactSettler.settleBatch body head", "PactSettler.t.sol WP-05 tests"]
tech_stack:
  added: []
  patterns:
    - "pre-loop fast-revert: if (registry.protocolPaused()) revert ProtocolPaused() as FIRST settleBatch body statement"
    - "pre-loop size gate: if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge() after pause, before loop"
key_files:
  created: []
  modified:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
decisions:
  - "P3 OPTIMIZED-DIVERGENCE honored: only authorized-settler+paused path tested; unauthorized+paused corner documents EVM divergence in WP-06 matrix per GATE-A ruling"
  - "Guard order is pause-then-batch-size matching settle_batch.rs:99-115 then :132-135 (Pitfall 3 avoided)"
  - "Additive-only insert: zero WP-04 lines deleted or reordered"
metrics:
  duration_seconds: 208
  completed_date: "2026-05-18"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
  commits: 2
requirements: [SET-11, SET-12]
---

# Phase 05 Plan 02: ProtocolPaused + BatchTooLarge Pre-Loop Guards Summary

**One-liner:** Pure additive insertion of `ProtocolPaused` fast-revert (first body statement) and `BatchTooLarge` size gate (second body statement) at the `settleBatch` head, ported bit-identically from `settle_batch.rs:99-115` and `:132-135`; 4 new tests GREEN, 90 WP-04 regression tests preserved (94 total).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | RED — ProtocolPaused / resume / BatchTooLarge failing tests | 89f43b7 | test/PactSettler.t.sol (+118 lines) |
| 2 | GREEN — insert pre-loop guards at settleBatch head | 26c6d3c | src/PactSettler.sol (+10 lines) |

## What Was Built

### SET-11: ProtocolPaused fast-revert (`settle_batch.rs:99-115`)

Inserted as the **first statement** in the `settleBatch` function body, before `BatchTooLarge` and the per-event loop:

```solidity
if (registry.protocolPaused()) revert ProtocolPaused();
```

`registry.protocolPaused()` reads the `bool public override protocolPaused` getter already present on `PactRegistry` (WP-02). No new state or interface changes required.

### SET-12: BatchTooLarge edge (`settle_batch.rs:132-135`)

Inserted immediately after the pause gate, before the loop:

```solidity
if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();
```

Strictly-greater rule: `events.length == 50` (MAX_BATCH_SIZE) is accepted; `events.length == 51` reverts. Matches Solana `event_count > MAX_BATCH_SIZE` exactly.

### Final `settleBatch` head (post-insert)

```solidity
function settleBatch(SettlementEvent[] calldata events)
    external
    override
    onlyRole(SETTLER_ROLE)
{
    if (registry.protocolPaused()) revert ProtocolPaused();
    if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();
    for (uint256 i = 0; i < events.length; i++) {
        // ... WP-04 loop body unchanged ...
    }
}
```

Line-order verification (post-insert): `ProtocolPaused` at line 70, `BatchTooLarge` at line 74, `for` loop at line 75.

### New Tests (4 total)

| Test | Scenario | Result |
|------|----------|--------|
| `test_ProtocolPaused_RejectsSettleBatch` | authorized settler + paused -> `ProtocolPaused.selector`; balances unchanged | GREEN |
| `test_ProtocolPaused_ResumesAfterUnpause` | pause -> revert; unpause -> fresh callId settles, `CallSettled(Settled)` emitted | GREEN |
| `test_BatchTooLarge_51EventsRevert` | 51 events -> `BatchTooLarge.selector` | GREEN |
| `test_BatchTooLarge_50EventsAccepted` | exactly 50 events -> no revert (boundary regression guard) | GREEN |

## Verification Results

- `forge build`: clean (compiler run successful; all lint notes are pre-existing, not introduced by this plan)
- `forge test --match-test "test_ProtocolPaused_*|test_BatchTooLarge_*"`: 4/4 PASS
- `forge test` (full suite): **94 passed, 0 failed** (90 WP-04 regression + 4 new)
- Additive-only: `git diff HEAD~ -- src/PactSettler.sol | grep '^-' | grep -v '^---'` returns empty (zero deletions)
- Guard order: `ProtocolPaused` (line 70) < `BatchTooLarge` (line 74) < `for` loop (line 75) — matches `settle_batch.rs` order (:99-115 pause THEN :132-135 batch size)

## Parity Notes

- **Solana authority:** `settle_batch.rs:99-115` (protocol-paused fast-revert) and `:132-135` (BatchTooLarge). Both ported bit-identically for the operationally-real paths.
- **P3 OPTIMIZED-DIVERGENCE** (GATE-A ruling honored): the unauthorized+paused corner intentionally diverges — EVM returns `AccessControlUnauthorizedAccount` (modifier fires before body) while Solana returns `ProtocolPaused`. This corner affects no real production path; documented for the WP-06 parity matrix. No test was written for this corner per GATE-A instruction.
- **D-LOCK-PROTO-PAUSE satisfied:** `ProtocolPaused` is the first body statement, fires before any per-event work or token transfer.
- **D-LOCK-BATCH satisfied:** `BatchTooLarge` fires after the pause gate and before the loop; strictly-greater (50 OK, 51 rejects).
- **Pitfall 3 avoided:** `BatchTooLarge` does NOT precede `ProtocolPaused`.
- **WP-04 90/90 regression preserved:** all prior tests pass unchanged.

## Deviations from Plan

None — plan executed exactly as written. The four tests were added verbatim from the `05-RESEARCH.md` "Test Port Plan" section. The two implementation lines were inserted exactly as specified in Task 2 `<action>`. No WP-04 code was touched.

## Known Stubs

None. This plan is purely additive with no placeholder code paths.

## Threat Flags

None. This plan adds read-only checks (`registry.protocolPaused()` is a view call; `events.length` is a calldata property) that early-revert before any state mutation. No new trust boundaries, endpoints, or auth paths introduced.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `src/PactSettler.sol` exists | FOUND |
| `test/PactSettler.t.sol` exists | FOUND |
| `05-02-SUMMARY.md` exists | FOUND |
| commit `89f43b7` (RED) exists | FOUND |
| commit `26c6d3c` (GREEN) exists | FOUND |
| `forge test` 94/94 green | PASSED |
| Zero deletions in PactSettler.sol | CONFIRMED |
