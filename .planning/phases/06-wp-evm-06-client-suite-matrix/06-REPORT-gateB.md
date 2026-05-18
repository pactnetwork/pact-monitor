# WP-EVM-06 — GATE B Report (request — captain approval needed)

**Date:** 2026-05-19
**Crew:** WP-EVM-06 (authored-at-turn, per GATE-A verdict)
**Status:** GATE B — all 11 tasks (T0-T11) complete, strict TDD per module,
file-scoped conventional commits. NO push. NO PR #204 comment. Working tree
clean (only `?? .claude/pr-reviews/`; `CLAUDE.md` unmodified; no
`.claude/skills/pact/` — no contamination). AWAITING captain approval
(verdict delivered as a file).

This is the FINAL parity WP. WP-07 (deploy/verify) is a separate cycle, out
of scope.

## Commit lineage (on `feat/arc-protocol-v1`, after `fd18f4d`)

- `73cde55` GATE-A report + captain verdict (docs)
- `0c82e52` T1 scaffold client package + D-A ABI drift guard
- `6f52e07` T2 constants.ts + addresses.ts
- `0b1efa8` T3 errors.ts selector map (amended once: tsc strict fix,
  unpushed — kept atomically green)
- `bf448a9` T4 encode.ts viem builders
- `a02b191` T5 state.ts view+event decoders
- `6b8d301` T6 helpers.ts + index.ts
- `cc15f4c` T7 Fuzz.t.sol + .gas-snapshot
- `585086b` T8 UsdcDecimals.t.sol + ArcConfig TODO resolved
- `af6891d` T9 parity matrix doc
- `7db633c` T10 design-spec §(d) 1-8 corrections

Scope: 36 files, +5085/-39 — all in-scope (`.planning/phases/06-*`,
`docs/superpowers/specs`, `packages/program-evm/protocol-evm-v1`
[Fuzz/UsdcDecimals tests + ArcConfig comment + .gas-snapshot],
`packages/protocol-evm-v1-client/*`, `pnpm-lock.yaml`). No WP-02/03/04/05
reopen. **0 WP-06 commits touched any settler/registry/pool/library
contract logic** (additive: 2 new forge test files + 1 comment-only
ArcConfig line + the new client package + 2 docs).

## Verification evidence (captain GATE-B acceptance gate)

| Gate | Result |
|---|---|
| `forge build` clean | PASS (no errors) |
| `forge test` 102 regression PRESERVED + new | **109/109, 0 failed** (102 ported + 5 fuzz + 2 decimals) |
| Client builds | PASS (`tsc -p tsconfig.build.json`, 0 TS errors) |
| Client tests | **41/41** (constants/addresses/errors/encode/state/helpers + index surface) |
| D-A ABI drift guard (run T1, re-run T7, T11) | **PASS** all 3 runs — committed `src/abi/*` in sync with a fresh `forge build` + locked `PactErrors.sol` (5 ABIs: PactRegistry/PactPool/PactSettler/PactEvents + PactErrors 30) |
| Parity matrix completeness | COMPLETE — 30/30 PactErrors + 12 §3 behaviors + §(d) 1-8 + all 7 `05-NA-MATRIX` rows + P3 corner, each tagged + file:line (`docs/superpowers/specs/2026-05-18-arc-parity-matrix.md` self-check) |
| Spec corrections traceable | DONE — §3=30 (FeeBpsSumOver10k added), §4 #7 corrected, §4 rows 9/10 added, "WP-EVM-06 Corrections" appendix enumerates all §(d) 1-8 (what+why), PR #201 §7.1 corrected |
| Contamination guardrail | CLEAN — tree only `?? .claude/pr-reviews/`; `CLAUDE.md`/`AGENTS.md`/`.claude/skills` untouched |

### Trigger-1 status (fee-split rounding)

NOT triggered. `testFuzz_FeeSplitSingleRecipient` /
`testFuzz_FeeSplitMultiRecipient` (257 runs each) prove
`premium*bps/10_000` u64 floor-div + conservation (`pool + Σfees ==
premium`) across the fuzzed input space — bit-identical to the spec §3
oracle. No parity defect in locked contract code; no HALT/escalation
needed. (A test-harness `feeCountHint` bug was found+fixed in T7 — the
contract behaved correctly: `feeRecipientsPresent=false` copies the default
Treasury template, stored count 1, ruling #5.)

### `pnpm -r build` — honest note (one PRE-EXISTING, unrelated failure)

`pnpm -r build` reports ONE failure: `packages/dummy-upstream` (`tsc:
command not found`; `node_modules missing`). This is a demo/fixture package
with no installed node_modules in this environment — **PRE-EXISTING and
unrelated to WP-EVM-06**: `git log fd18f4d..HEAD -- packages/dummy-upstream`
= 0 commits (no WP-06 commit touched it). The new
`@pact-network/protocol-evm-v1-client` builds clean (exit 0) and the sibling
`@pact-network/protocol-v1-client` still builds clean; `pnpm install`
recognized the new workspace member. Workspace integration for the WP-06
deliverable is intact; the dummy-upstream gap is not a regression and not in
scope to fix here.

## Deliverables (spec §9, scoped to WP-06)

1. `@pact-network/protocol-evm-v1-client` — NEW pnpm workspace member,
   mirrors `protocol-v1-client` module map (addresses/encode/state/errors/
   constants/helpers/index) via viem; D-A committed curated ABIs + drift
   guard. Builds + 41 tests green.
2. Consolidated forge fuzz (5 properties, 257 runs) + `.gas-snapshot`
   baseline; additive, no contract change.
3. Live `IERC20(USDC).decimals()==6` assertion + negative control;
   ArcConfig `TODO(WP-EVM-06)` resolved (comment-only).
4. Per-variant parity matrix (`2026-05-18-arc-parity-matrix.md`) — 30/30 +
   §3 + §(d)1-8 + 05-NA + P3.
5. Design-spec formally corrected for ALL §(d) 1-8; corrects PR #201 §7.1.

## Decisions honored (GATE-A verdict)

D-A (committed ABI + drift guard, CONDITION met: forge-build-vs-committed
diff, run T1/T7/T11, all PASS) · D-B (addresses.ts null placeholders +
env overlay) · D-C (matrix at `docs/superpowers/specs/`, spec corrected
in place + appendix enumerating §(d) 1-8 — CONDITION met) · D-D (helpers
= defaultFeeRecipients + validateFeeRecipients fee.rs parity; SPL/PDA
helpers N-A in matrix). Authored-at-turn, strict TDD RED-before-GREEN per
module, 3 STOP-AND-ASK triggers in force (none fired), GitNexus deferred
per §(e).

## Status

GATE B request. NO push. NO PR #204 comment. Working tree clean. AWAITING
captain approval (verdict delivered as a file). On approval: captain drives
push + PR #204 completion comment + closeout + handoff seed.
