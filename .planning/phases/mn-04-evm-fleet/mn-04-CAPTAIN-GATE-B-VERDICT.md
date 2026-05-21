# WP-MN-04 — Captain Gate B Verdict

- **Date:** 2026-05-21
- **Captain:** Tu (available post Mac emergency restart 2026-05-21)
- **Verdict:** **APPROVED** — captain-proxy recommends merge into `feat/multi-network`.

---

## 7-category Gate B exit — captain-proxy attestation

1. **PLANs T1..T5 closed atomically.** SHAs `a74a2f5` / `b56d526` / `688870d` / `2fed63b` / `a7d077c`. Each through implementer → spec-reviewer → code-quality reviewer → amend cycle. No commit landed without paired review. See `mn-04-REPORT-gateB.md` §1.

2. **Tests green.** 347 across the four affected packages; +21 net new. Pre-existing 7 failures (4 indexer DB / 3 market-proxy BigInt) unchanged and confirmed non-T-task-caused. `evm-adapter-contract.test.ts` 4/4. `evm-adapter-unit.test.ts` 11/11. WP-MN-03b's byte-identical adapter-swap GATE STILL 3/3 PASS after T5's submitViaAdapter routing fix. See `mn-04-REPORT-gateB.md` §2 §3.

3. **Drift / contract checks PASS.** EvmAdapter satisfies the WP-MN-02 ChainAdapter contract. SubmitterService routes by `descriptor.vm`. Indexer dedup is `@@id([network, callId])` on Call (regression-locked). Market-proxy proxy routes by `endpoint.network`. No silent fallback; explicit 503 on missing adapter.

4. **Spec parity.** D6 (reorg/finality policy doc) implemented verbatim — Arc `finalityBlocks=64`, EIP-1559 primary + legacy fallback, (network, callId) dedup, manual operator reorg-rollback. Off-chain spec §2.5 (per-VM auth) + §2.6 (reorg/idempotency) satisfied. Phased plan §7 deliverables present except T6 (Tu-executable runbook by design). See `mn-04-REPORT-gateB.md` §4.

5. **Rollback** documented at three layers (branch `pre-mn-04-rollback`; operational `PACT_ENABLED_NETWORKS` env removal; on-chain `revokeRole(SETTLER_ROLE, addr)`). No production-DB writes in this WP — schema view is local-docker-only per Tu's directive.

6. **This verdict** issued by captain-proxy on Tu's behalf. Tu is the authoritative captain and may override.

7. **Handoff update queued** for post-merge alongside cockpit-spoke + WP-MN-05 unblock prompt to Ken.

---

## Captain-proxy verdict notes

This is the second-largest WP in the MN track (after WP-MN-03b's live-service swap). It stands up the first non-Solana fleet end-to-end at the code level. T6 (Tu's runbook) is the only remaining step before Arc Testnet traffic flows.

**Five process deviations** (all transparent in `mn-04-REPORT-gateB.md` §"Process deviations"):
- T5 scope reduction (post-Mac-emergency-restart, Tu-approved Option C: routing-dispatch only, not viem-level e2e)
- Latent EVM signer routing bug surfaced AND fixed in T5 (would have been a T6 production fault)
- 13+ plan-vs-real corrections across T1..T4 — all amended via review-loops
- Phase 2 Secret Manager / ConfigService bypass: documented Phase 2 carry-forward, not a current bug
- Pre-existing T2-introduced build break (`adapters.service.ts` importing the deleted stub) — carried through T3 and naturally fixed by T4 (same code site)

None of these breached the spec deliverable shape. All are documented.

---

## Three open follow-ups (NOT blocking Gate B merge)

| # | Item | Owner |
|---|---|---|
| 1 | T6 Arc fleet boot runbook (Cloud Run env update + on-chain SETTLER_ROLE grant + smoke) | Tu |
| 2 | Rick Phase 2 Secret Manager migration — create `pact-settler-arc-testnet` + swap env value to `projects/...` path (D6 §6, no code change) | Rick |
| 3 | `cleanup/remove-mn-direct-client-flag` after 1 week stable Arc operation — remove PACT_LEGACY_DIRECT_SOLANA + submitLegacyDirect + refreshLegacyDirect + legacy createBalanceCheck | Whoever holds on-call rotation that week |

---

## Standing instructions for merge

- Implementer is `superpowers:subagent-driven-development` (closed at T5). Merge is captain-proxy mechanical.
- **NO remote push** until Tu explicit-go on the merge command.
- After merge: tag `pre-mn-05-rollback` on `feat/multi-network` immediately.
- After tag: update `~/cockpit-hub/spokes/pact-network/handoff.json`.
- Optional: run `npx gitnexus analyze` from the primary checkout `/Users/q3labsadmin/Q3/Solder/pact-network` to refresh the code-intel index for the next track (WP-MN-05 or cleanup WP).

---

## Verdict

**APPROVED.** Ready for Tu's "merge it" go-ahead.
