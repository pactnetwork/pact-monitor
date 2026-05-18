---
phase: 05-wp-evm-05-pactsettler-hardening
plan: "03"
subsystem: protocol-evm-v1
tags: [evm, pact-settler, endpoint-paused, tdd, parity-port, SET-11]
dependency_graph:
  requires: ["05-02"]
  provides: ["EndpointPaused per-event check at D-LOCK-PREC slot"]
  affects:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
tech_stack:
  added: []
  patterns:
    - "per-event pause guard inserted additively between dedup READ and RecipientCoverageMismatch"
    - "strict TDD RED (behavioral FAIL) -> GREEN (97/97 full suite)"
key_files:
  created: []
  modified:
    - packages/program-evm/protocol-evm-v1/src/PactSettler.sol
    - packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol
decisions:
  - "D-LOCK-PREC slot confirmed: dedup READ (:84) < getEndpoint < EndpointPaused (:102) < RecipientCoverageMismatch (:104) < dedup SET (:111)"
  - "Placeholder comment `Endpoint-paused check (settle_batch.rs:209-211) is WP-05; skip.` replaced — only removed line in PactSettler.sol diff"
  - "test_EndpointPaused_DedupReadPrecedesEndpointPaused passes pre-impl and post-impl (conditional RED, regression guard)"
metrics:
  duration: "~10 min"
  completed: "2026-05-18"
  tasks: 2
  files_modified: 2
requirements: [SET-11]
---

# Phase 05 Plan 03: EndpointPaused Per-Event Check (D-LOCK-PREC Slot) Summary

**One-liner:** `if (ep.paused) revert EndpointPaused();` inserted at the LOCKED D-LOCK-PREC slot — after dedup READ, after getEndpoint, before RecipientCoverageMismatch — porting settle_batch.rs:209 (SET-11) as a pure additive insert with 3 new tests; 97/97 forge suite green.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | RED — EndpointPaused per-event / resume / D-LOCK-PREC tests | c14a254 | test/PactSettler.t.sol (+80 lines) |
| 2 | GREEN — insert EndpointPaused at D-LOCK-PREC slot | 5e47e3a | src/PactSettler.sol (+4 lines, -1 placeholder comment) |

## What Was Built

### Task 1 (RED)

Three failing test functions appended to `test/PactSettler.t.sol`:

- **`test_EndpointPaused_RevertsPerEvent`** — pause endpoint via `reg.pauseEndpoint(SLUG, true)`, call `settleBatch`, expect `EndpointPaused.selector` revert. Confirmed FAIL RED: call proceeded without reverting (no per-event check existed).
- **`test_EndpointPaused_CanResumeAfterUnpause`** — pause then unpause, settleBatch must succeed. Conditional RED (passes pre-impl; RED established by RevertsPerEvent).
- **`test_EndpointPaused_DedupReadPrecedesEndpointPaused`** — consume callId while live, pause endpoint, replay same callId, expect `DuplicateCallId.selector`. Conditional RED (dedup READ at :84 already precedes; passes pre-impl and post-impl — regression guard for D-LOCK-PREC).

### Task 2 (GREEN)

Single additive edit to `src/PactSettler.sol` in the `settleBatch` per-event loop:

```solidity
// BEFORE (WP-04):
// Step 4: endpoint snapshot — settle_batch.rs:200-221.
// Endpoint-paused check (settle_batch.rs:209-211) is WP-05; skip.
IPactRegistry.EndpointConfig memory ep =
    IPactRegistry(address(registry)).getEndpoint(ev.endpointSlug);
if (ep.feeRecipientCount != ev.feeRecipientCountHint)
    revert RecipientCoverageMismatch();

// AFTER (WP-05 05-03):
// Step 4: endpoint snapshot — settle_batch.rs:200-221.
IPactRegistry.EndpointConfig memory ep =
    IPactRegistry(address(registry)).getEndpoint(ev.endpointSlug);
// settle_batch.rs:209 — EndpointPaused (SET-11). D-LOCK-PREC slot:
// AFTER the DuplicateCallId dedup READ (:84) and getEndpoint, BEFORE
// RecipientCoverageMismatch. Pure additive insert — no WP-04 reorder.
if (ep.paused) revert EndpointPaused();
if (ep.feeRecipientCount != ev.feeRecipientCountHint)
    revert RecipientCoverageMismatch();
```

`ep.paused` is `bool` (IPactRegistry.EndpointConfig:25); `EndpointPaused()` is in PactErrors.sol (confirmed). Solana's `ep.paused != 0` maps exactly to EVM bool truthiness.

## Parity Verification

| Solana anchor | EVM line | Status |
|---------------|----------|--------|
| settle_batch.rs:194 dedup READ | PactSettler.sol:94 | Unchanged (WP-04) |
| settle_batch.rs:209 EndpointPaused | PactSettler.sol:102 | NEW — this plan |
| settle_batch.rs:213 RecipientCoverageMismatch | PactSettler.sol:104 | Unchanged (WP-04) |
| settle_batch.rs:248-262 dedup SET | PactSettler.sol:111 | Unchanged (WP-04) |

D-LOCK-PREC slot ordering: 94 < 98 < 102 < 104 < 111. Correct.

## Test Results

- `test_EndpointPaused_RevertsPerEvent` — PASS (GREEN after impl)
- `test_EndpointPaused_CanResumeAfterUnpause` — PASS (GREEN)
- `test_EndpointPaused_DedupReadPrecedesEndpointPaused` — PASS (GREEN, regression guard confirmed)
- `test_DuplicateCallIdPrecedesRecipientCoverageMismatch` — PASS (LOCKED WP-04 test preserved)
- Full suite: **97/97 passed, 0 failed** (94 prior + 3 new 05-03 tests)

## Deviations from Plan

None — plan executed exactly as written.

- TDD RED confirmed for the right behavioral reason (call did not revert with EndpointPaused).
- Conditional RED for `test_EndpointPaused_CanResumeAfterUnpause` and `test_EndpointPaused_DedupReadPrecedesEndpointPaused` was anticipated and documented in plan task 1.
- Additive-only: only the WP-04 placeholder comment line was removed from PactSettler.sol (confirmed by `git diff` showing one `-` line).

## Known Stubs

None. The EndpointPaused check is fully wired: `ep.paused` is read live from `registry.getEndpoint()` which reads `PactRegistry.endpoints[slug].paused` — no mock or hardcoded values.

## Threat Flags

None. The insert reads an existing registry field (`ep.paused`) via an already-trusted call (`getEndpoint`), within the existing SETTLER_ROLE-gated function. No new network endpoints, auth paths, or trust boundaries introduced.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `PactSettler.sol` exists | FOUND |
| `PactSettler.t.sol` exists | FOUND |
| `05-03-SUMMARY.md` exists | FOUND |
| Commit c14a254 (RED) exists | FOUND |
| Commit 5e47e3a (GREEN) exists | FOUND |
| Exactly 1 `if (ep.paused) revert EndpointPaused();` line in PactSettler.sol | FOUND |
| Exactly 3 `function test_EndpointPaused` functions in PactSettler.t.sol | FOUND |
| forge test: 97/97 passed, 0 failed | CONFIRMED |
| `test_DuplicateCallIdPrecedesRecipientCoverageMismatch` still PASSES | CONFIRMED |
| Only WP-04 placeholder comment removed (additive-only) | CONFIRMED |
