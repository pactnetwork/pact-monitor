# MN-04 EVM settle-path fix-WP — Task 2 REPORT

**Crew:** crew-1
**Branch:** `fix/mn-04-evm-settle-path`
**Date:** 2026-05-22
**Scope:** Task 2 — indexer EVM accounting (finding 5: 5a pusher, 5b indexer).
**Status:** DONE. e2e is **7-of-8 green** — the only RED test is #1 (auth / finding 3 → Task 3). Zero Solana regression.

---

## 1. Commit

| Commit | What changed |
|---|---|
| `43c6fde` | `fix(settler): stamp batch-level network on indexer push (mn-04 fix-WP T2, finding 5)` |

Files changed (3):
- `packages/settler/src/indexer/indexer-pusher.service.ts` — **5a production fix**.
- `packages/settler/src/indexer/indexer-pusher.service.spec.ts` — pusher lock + Solana regression tests.
- `packages/indexer/test/events.service.spec.ts` — 5b lock tests (arc propagation + Solana regression).

No production change to `packages/indexer/src/events/events.service.ts` — see §3. No `shared` change (no rebuild needed).

---

## 2. What changed (5a) and why 5b needed no code

**5a — pusher (`indexer-pusher.service.ts`).** `push()` sent no batch-level `network`, so `dto.network` arrived `undefined` at the indexer. New `resolveBatchNetwork(batch)` derives one network for the batch (the batcher already partitions by `(network, slug)` in Task 1, so every batch is single-network), **enforces** the single-network invariant (throws on a mixed-network batch), and the body now carries `network`.

**5b — indexer (`events.service.ts`).** Already correct: `batchNetwork = dto.network ?? "solana-devnet"` (line 130) keys every aggregate row — Settlement (178-180), Endpoint-FK (139-141), PoolState (314-316), SettlementRecipientShare (276), RecipientEarnings (290-292) — and the Call row uses `call.network ?? "solana-devnet"` (351,356). I verified by grep that the only two `solana-devnet` literals are those `??` fallbacks; nothing hardcodes the network. So once 5a supplies `dto.network`, Arc rows land under `arc-testnet` and Solana under `solana-devnet`. No production edit to events.service.ts was warranted (per surgical-change discipline); I locked the behavior with tests instead. The `?? "solana-devnet"` fallback is intentionally kept for legacy unstamped events (per the DTO contract).

---

## 3. e2e RED→GREEN (before/after)

Acceptance test `arc-testnet-settle-e2e.spec.ts` (8 tests):

| | passed/total | RED |
|---|---|---|
| After Task 1 | 6/8 | #5 indexer (finding 5), #1 auth (finding 3) |
| **After Task 2** | **7/8** | **#1 auth (finding 3 → Task 3) only** |

#5 (`indexer ingest ... ALL under arc-testnet`) is now GREEN: the real `IndexerPusherService` stamps `network: 'arc-testnet'`, and the real `EventsService` (fed that body, in-memory Postgres) writes Settlement / endpoint-FK / PoolState / recipient-share rows all under `arc-testnet`, zero defaulted to `solana-devnet`.

---

## 4. Full suite results — zero Solana regression

```
@pact-network/settler: Test Files 1 failed | 12 passed (13)
                       Tests 1 failed | 85 passed (86)
   -> the only failure is e2e #1 auth (finding 3, Task 3)

@pact-network/indexer: Test Suites 1 failed | 12 passed (13)
                       Tests 4 failed | 88 passed (92)
   -> the only failures are in test/migration-rollback.spec.ts
```

**The 4 indexer failures are pre-existing and environmental, NOT a Task 2 regression.** `migration-rollback.spec.ts` needs a live Postgres; with my change stashed it still fails with `PrismaClientInitializationError` x4 (no DB in this worktree). Proof:
```
$ git stash push packages/indexer/test/events.service.spec.ts
$ pnpm --filter @pact-network/indexer exec jest migration-rollback
  FAIL test/migration-rollback.spec.ts
  PrismaClientInitializationError x4   Tests: 4 failed, 4 total
```
All other indexer suites pass, including `events.service.spec.ts` (16/16, with my 2 new tests).

Settler Solana guards still green: `adapter-swap-e2e`, `pipeline.e2e`, `submitter`/`batcher`/`indexer-pusher` specs, `arc-testnet-routing`.

---

## 5. Solana-still-solana-devnet proof (regression assertions added)

- **Pusher level** (`indexer-pusher.service.spec.ts`):
  - `stamps batch-level network from an arc-testnet batch` → `body.network === "arc-testnet"`.
  - `defaults batch-level network to solana-devnet for unstamped batches` → `body.network === "solana-devnet"` (Solana regression).
  - `throws on a mixed-network batch (single-network invariant)`.
- **Indexer level** (`events.service.spec.ts`):
  - `finding 5: an arc-testnet batch stamps every aggregate + call row under arc-testnet` (all rows arc-testnet; none other).
  - `regression: an unstamped batch lands every aggregate + call row under solana-devnet`.

Both indexer tests use a shared `assertAllRowsUnderNetwork` helper that checks every persisted row (Settlement, Endpoint, PoolState, SettlementRecipientShare, RecipientEarnings, Call) carries the expected network and none leaked to another.

---

## 6. Acceptance-test gate not weakened

The acceptance test was **not touched** in Task 2:
```
$ git diff d24a04b -- packages/settler/test/arc-testnet-settle-e2e.spec.ts
(empty)
```
No assertion changed; #5 went green purely from the production fix. The seam is still never mocked (unchanged from T0/T1).

---

## 7. Notes for the captain

- **Pre-existing tsc errors not worsened:** `pnpm --filter @pact-network/settler typecheck` still reports exactly **2** errors (`indexer-pusher.service.spec.ts`, `submitter.service.spec.ts`, SettleMessage `ack`/`nack`/`raw` fixture shape). My pusher change did not force a fixture update — the pusher spec asserts individual fields (not full-body `toEqual`), so adding `network` to the body broke nothing, and my new pusher tests reuse the existing `makeBatch` fixture (no new error category). Left untouched per your instruction.
- **Single-network enforcement** is a fail-loud guard (throws) consistent with your scope note; it can only fire if the Task 1 batcher partitioning regresses.
- **gitnexus** not run (worktree corrupts CLAUDE.md/AGENTS.md per repo rule; pact-network isn't in the local index). Impact was manual: `push()` callers = `PipelineService.processBatch` (per-batch, unaffected); `events.service.ts` unchanged.

## 8. Self-check vs. Task 2

- [x] 5a: pusher sends batch-level network; single-network enforced
- [x] 5b: indexer uses batch network (already wired); Arc→arc-testnet, Solana→solana-devnet; locked with tests
- [x] e2e #5 GREEN → 7-of-8 (only #1 auth RED, Task 3)
- [x] Solana ingest still solana-devnet — regression assertions added (pusher + indexer)
- [x] Acceptance-test assertions untouched (empty diff); gate not weakened
- [x] Full settler + indexer suites run; only pre-existing/env + Task-3 failures remain
- [x] Pre-existing tsc errors not worsened (still 2)
