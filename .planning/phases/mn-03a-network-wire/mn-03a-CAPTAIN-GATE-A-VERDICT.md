# WP-MN-03a — Captain Gate A Verdict

- **Date:** 2026-05-20
- **Captain:** Tu (out-of-office); verdict issued by **captain proxy**
- **Verdict:** **APPROVED**

## Captain-proxy checks

1. **R1 sanity — SettlementEvent producer count.** Re-grep confirmed exactly ONE production constructor: `packages/wrap/src/wrapFetch.ts:164` (`const event: SettlementEvent = { ... }`). All other matches are type imports, type aliases, or test fixtures. RESEARCH §2 audit is complete.

2. **Idempotency-key audit.** RESEARCH §3 enumerated 4 sites in the indexer: Settlement upsert at `events.service.ts:168`, Call insert by callId PK in `tryInsertCall`, the controller `@Post()` handler, and the DTO definitions. Confirmed via grep.

3. **Prisma model count.** 6 models in scope: Call, Settlement, SettlementRecipientShare, PoolState, RecipientEarnings, Endpoint. `Agent` correctly excluded (wallet-identity is network-agnostic). Confirmed via `grep ^model packages/db/prisma/schema.prisma`.

4. **Read-API controller count.** 4 distinct controller files (`stats/stats.controller.ts`, `api/calls.controller.ts`, `api/endpoints.controller.ts`, `api/agents.controller.ts`). The agents controller hosts BOTH `/api/agents/:pubkey` and `/api/agents/:pubkey/calls` — so 5 endpoint surfaces across 4 controllers. RESEARCH §5.4 + sub-task `mn-03a-05` correct.

5. **Spec parity — §2.2 REV1 additivity.** RESEARCH §1 quotes the REV1 language verbatim. No rename, no collapse, just `+network`.

6. **Migration reversibility.** RESEARCH §4.2 specifies a CI down-migration test (`migration-rollback.test.ts`). Sound.

7. **Backward compat.** RESEARCH §6 sub-task `mn-03a-05` includes a wire-compat e2e test exercising pre↔post 03a combinations. Sound.

8. **Carry-forward from WP-MN-02 (EndpointConfigSnapshot projection drift)** correctly deferred to WP-MN-03b RESEARCH per the CONTEXT — NOT in WP-MN-03a scope.

## Standing instructions

- Implementer is `superpowers:writing-plans` → 5 PLANs at `docs/superpowers/plans/2026-05-20-wp-mn-03a-network-wire.md` → `superpowers:subagent-driven-development`.
- **NO remote pushes** until Gate B closes.
- **HIGHEST-RISK** sub-task is `mn-03a-03` (Prisma migration). CI down-migration test is the gate.
- Pause-and-escalate on RESEARCH-contradicting findings.
- Tag `pre-mn-03b-rollback` on `feat/multi-network` immediately after WP-MN-03a Gate B + merge.

## Verdict

**APPROVED.** Proceed to writing-plans for WP-MN-03a.
