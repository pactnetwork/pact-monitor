# WP-MN-02 — Captain Gate A Verdict

- **Date:** 2026-05-20
- **Captain:** Tu (out-of-office); verdict issued by **captain proxy** per Tu's go-go directive
- **Verdict:** **APPROVED — with one clarification note added to RESEARCH §2.4**

---

## What captain-proxy checked

1. **R1 sanity — service-side `@pact-network/protocol-v1-client` import-site re-grep.**
   ```bash
   grep -rln "from ['\"]@pact-network/protocol-v1-client['\"]" packages/{settler,indexer,market-proxy,wrap,sdk,facilitator,cli}/src/
   ```
   Returned **9 files**:

   **Service production code (✓ covered by RESEARCH §2.1–2.2):**
   - `packages/settler/src/submitter/submitter.service.ts` — §2.1
   - `packages/indexer/src/sync/on-chain-sync.service.ts` — §2.2

   **Service test code (NOT explicitly enumerated in RESEARCH — clarification added below):**
   - `packages/settler/src/pipeline/pipeline.e2e.spec.ts`
   - `packages/settler/src/indexer/indexer-pusher.service.spec.ts`
   - `packages/settler/src/submitter/submitter.service.spec.ts`

   **CLI admin tooling (RESEARCH §2.4 deferred):**
   - `packages/cli/src/cmd/balance.ts`
   - `packages/cli/src/cmd/pause.ts`
   - `packages/cli/src/cmd/approve.ts`
   - `packages/cli/src/lib/solana.ts`

   **Clarification:** The 3 service test files import `FeeRecipientKind` (an enum type) — they don't exercise chain-touch logic, just construct test fixtures. WP-MN-02 doesn't need to mirror this on the adapter (the type stays exported by `protocol-v1-client`). WP-MN-03b swap of the service production code does NOT require swapping the test imports of `FeeRecipientKind`. Acceptable as-is.

2. **R2 sanity — no legacy Anchor crate references in service code.** `grep -rn "pact-insurance" packages/{settler,indexer,market-proxy,wrap,sdk}/src/` returned empty. ✓

3. **R3 sanity — workspace dep direction.** Confirmed: `@pact-network/protocol-v1-client` and `@pact-network/wrap` do NOT depend on `@pact-network/shared`. Adding shared → both as a workspace dep creates no cycle.

4. **§4.1 interface shape — REV1 compliance.** Confirmed: no `watch()` method, `readEndpointConfigs()` + optional `tailSettlementEvents?()` present, matches arch §3 L2 post-REV1.

5. **§5.1 location decision — symmetric with future EvmAdapter.** Accepted. `packages/shared/src/adapters/solana/` + `packages/shared/src/adapters/evm/` keeps adapters as one hub.

6. **§5.2 dep direction — bundle weight.** Accepted. Shared has zero current consumers; new deps don't burden anyone today. WP-MN-05 (Ken's SDK) is the next downstream consumer and will already pull in `@solana/web3.js` for Solana calls.

7. **§5.4 parity-test strategy — offline.** Accepted. Reuses existing test-stub patterns from `submitter.service.spec.ts` and `wrap/balanceCheck.test.ts`.

8. **§6 sub-task split.** 4 PLANs, each ≈5–8 steps. Well-sized.

9. **§7 risks.** R1–R6 all have mitigations; R1 is the most important (missing call site) and is mitigated by the §2 mapping table + §5.4 parity tests forcing exercise.

10. **§8 open question** about `getCallRecord` correctly deferred to WP-MN-03b RESEARCH.

---

## Standing instructions for execution

- Implementer is `superpowers:writing-plans` → 4 task plan at `docs/superpowers/plans/2026-05-20-wp-mn-02-chain-adapter.md` → `superpowers:subagent-driven-development` to dispatch a fresh Sonnet subagent per task with two-stage review.
- **No remote pushes** until Gate B closes (mirrors WP-MN-01 cadence; PR opens to `feat/multi-network` only after Gate B verdict).
- Each task atomic commit on `feat/multi-network-02-chain-adapter`, conventional-commit prefixes.
- **Pause-and-escalate on any RESEARCH-contradicting finding** (per the WP-MN-01 R1 precedent — saved this WP from shipping an incomplete grep audit).
- After all 4 tasks green + final code review, author `mn-02-REPORT-gateB.md`, captain-proxy Gate B verdict, tag `pre-mn-03a-rollback` on `feat/multi-network` (after merge), open PR vs `feat/multi-network`, merge, update handoff. Then proceed to WP-MN-03a.

---

## Verdict

**APPROVED.** Proceed to writing-plans for WP-MN-02.
