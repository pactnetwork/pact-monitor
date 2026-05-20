# WP-MN-01 — Captain Gate A Verdict

- **Date:** 2026-05-20
- **Captain:** Tu (out-of-office); verdict issued by **captain proxy** (Claude, per Tu's directive "fully automatic" while out for lunch)
- **Verdict:** **APPROVED — with RESEARCH amended**

---

## What the captain-proxy checked

1. **Vanilla re-grep `ArcConfig` across `packages/` (R1 mitigation).** Ran `grep -rn "ArcConfig" packages/`. Returned **68 matches across 17 files** — vs RESEARCH's original claim of "40 lines across 12 files." The original audit missed:
   - `packages/program-evm/protocol-evm-v1/src/PactRegistry.sol` (lines 7, 114)
   - `packages/program-evm/protocol-evm-v1/src/PactSettler.sol` (lines 9, 74, 82, 83)
   - `packages/program-evm/protocol-evm-v1/src/libraries/FeeValidation.sol` (lines 5, 32, 44, 64, 130, 132, 140, 154)
   - `packages/program-evm/protocol-evm-v1/test/PactRegistry.t.sol` (lines 7, 60)
   - `packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol` (lines 13, 336)

   **Disposition.** Every missed reference is to a **protocol-wide invariant** (MAX_BATCH_SIZE / MIN_PREMIUM / MAX_FEE_RECIPIENTS / ABSOLUTE_FEE_BPS_CAP / DEFAULT_MAX_TOTAL_FEE_BPS). No chain-specific value leaks into the contract layer. The substance of the WP doesn't change — these files need an `import` rename and a type-qualifier rename, nothing more. RESEARCH §2.1, §2.2, §2.6, §2.7 amended to reflect the full picture. RESEARCH "totals" updated from "40 / 12 files" → "68 / 17 files."

2. **§5.1 chains.json schema.** Sound. Four required keys + three nullable reserved slots for D6 fields. Treasury intentionally NOT in chains.json (per-deployment env var) — correct. Approved.

3. **§5.2 `EXPECTED_USDC_DECIMALS` placement.** Sound. Stays protocol-wide; per-chain `usdcDecimals` is a documented assertion the drift test cross-checks. Preserves the existing Deploy.s.sol guard. Approved.

4. **§5.3 chains.json location.** Sound. `packages/program-evm/protocol-evm-v1/config/chains.json` keeps Foundry's `vm.readFile` happy. Cross-package shared location rejected with documented rationale. Approved.

5. **§5.4 drift-test design.** Sound. Three Vitest assertions, runtime <50ms, single source of truth at the TS/JSON boundary. Approved.

6. **§6 sub-task split.** Four PLAN files (T1 rename + grep audit follow-through, T2 chains.json + schema, T3 Deploy.s.sol refactor, T4 drift test + neg test). Well-sized; each ≈5 atomic steps. Approved.

7. **§7 risks.** R1 (grep audit completeness) fired and was caught + corrected. R2–R5 mitigations valid. Approved.

8. **§8 open questions.** None blocking. Approved.

---

## What captain-proxy did NOT delegate

- The captain-proxy did **not** re-author RESEARCH from scratch; the gap was an **additive** correction (more files in the audit, same disposition for all of them). The decision-shape of WP-MN-01 is unchanged.
- The captain-proxy did **not** alter Tu's earlier-locked design decisions (D1–D6, branch model, 7-cat Gate B template, per-WP cadence). Those remain ratified.

---

## Standing instructions for execution

- Implementer is `superpowers:writing-plans` → 4 tasks in one plan at `docs/superpowers/plans/2026-05-20-wp-mn-01-evm-contract-generalize.md` → `superpowers:subagent-driven-development` to dispatch a fresh Sonnet subagent per task with two-stage review.
- **No remote pushes** until Gate B closes and Tu reviews on return. Local branches only: `feat/multi-network`, `feat/multi-network-01-evm-contract-generalize`.
- Each task commit on `feat/multi-network-01-evm-contract-generalize` is atomic per the convention. Conventional commits (`feat:` / `refactor:` / `test:` / `docs:`).
- If any task hits a Gate-A-class surprise (a finding that contradicts RESEARCH the way §2.6 was contradicted today), the implementer **pauses execution**, surfaces the finding, and a fresh captain-proxy verdict is required before continuing.
- If the implementer can complete all 4 tasks green, proceed to Gate B request artifact (`mn-01-REPORT-gateB.md`), then captain-proxy Gate B verdict, then tag `pre-mn-01-rollback`, then handoff doc update. Stop there — Tu reviews before deciding to push, open PR, or open WP-MN-02.

---

## Verdict

**APPROVED.** Proceed to writing-plans for WP-MN-01.
