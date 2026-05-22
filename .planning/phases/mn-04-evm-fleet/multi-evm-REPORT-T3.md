# Multi-EVM WP — Task 3 Report (per-network sync cursor + parallel config-sync)

**Branch:** `feat/concurrent-multi-evm`
**Commit:** `7431449` — `feat(indexer,shared,db): per-network config-sync cursor + parallel refresh (multi-evm WP T3)` (7 files, +409 / -20)
**Status:** DONE. Cursor functional; config-sync parallelized; zero regressions (DB-needing `migration-rollback.spec` failures pre-existing/env-only, isolated below).

## Two STOP-AND-ASK decisions (the task's scoped files didn't match reality)

1. **Where the height-scaling scan lives.** The task pointed to
   `on-chain-sync.service.ts:210-235` as "the chunked scan", but that is the
   legacy Solana `getProgramAccounts` path (no block walk). The real 9.5k-block
   `deploymentBlock` walk is in `EvmAdapter.readEndpointConfigs()` (shared). A
   cursor in the indexer alone would be cosmetic. **You chose:** add an OPTIONAL
   adapter method (keep existing `readEndpointConfigs()` + SolanaAdapter + all
   current adapter tests/settler mocks unchanged).
2. **Refresh correctness.** Naively cursoring the discovery scan would stop
   refreshing existing endpoints' mutable config (`paused`/premium changed via
   `update_config`, which emits no `EndpointRegistered`). **You chose:** cursor
   DISCOVERY + refresh KNOWN — `readEndpointConfigsFrom(fromBlock, knownSlugs[])`
   unions newly-discovered slugs with the indexer's known slugs and multicalls
   the full set.

## Impact analysis (manual — GitNexus has no pact-network index)

- `ChainAdapter` interface: added an OPTIONAL method, so existing implementors
  (SolanaAdapter) and consumers (settler/proxy mocks) are unaffected (d=1 = none
  broken).
- `EvmAdapter.readEndpointConfigs()` refactored to delegate to the new method —
  observable behavior identical (walks from `deploymentBlock`, same chunking),
  so its 3 unit tests (#6/#7/#12) stay green.
- `OnChainSyncService.refreshAllNetworks` / `refreshViaAdapter`: indexer-internal.

## SyncCursor model + migration

`packages/db/prisma/schema.prisma`:

```prisma
model SyncCursor {
  network          String   @id @db.VarChar(24)
  lastScannedBlock BigInt
  updatedAt        DateTime @updatedAt
}
```

Migration: `packages/db/prisma/migrations/20260522000000_add_sync_cursor/migration.sql`
(hand-written `CREATE TABLE "SyncCursor"` with `network` PK). **NOT applied** —
no local/docker Postgres is running and no `PG_URL` is set, so per your
instruction I generated the SQL and committed it without pointing at any DB.
`prisma generate` WAS run (offline) so the client carries the `syncCursor`
delegate for typecheck/build. To apply locally later:
`pnpm --filter @pact-network/db exec prisma migrate deploy` against a local
docker Postgres only.

## Cursor read/persist logic (`refreshViaAdapterWithCursor`)

- Resume point:
  - cold start (no `SyncCursor` row) -> `getChain(network).deploymentBlock`.
  - warm -> `lastScannedBlock + 1n` (we already scanned through
    `lastScannedBlock`; finalized blocks don't reorg, so +1 never misses an
    event and avoids re-scanning the boundary block).
- Known slugs: `prisma.endpoint.findMany({ where: { network }, select: { slug } })`
  -> passed to `readEndpointConfigsFrom(fromBlock, knownSlugs)` so existing
  endpoints' mutable config is refreshed every tick.
- Persist: `prisma.syncCursor.upsert({ ..., lastScannedBlock: scannedToBlock })`
  AFTER a successful pass only (a mid-sync failure re-scans the same range next
  tick rather than skipping it).
- Routing: `refreshViaAdapter` uses the cursor path when
  `typeof adapter.readEndpointConfigsFrom === "function"` (EVM); Solana
  (`getProgramAccounts`, not height-scaling) falls back to plain
  `readEndpointConfigs`.

## Adapter change (`EvmAdapter.readEndpointConfigsFrom`)

Resolves `finalized` to a concrete block; seeds the refresh set with
`knownSlugs`; scans `[fromBlock..finalized]` in the PR #224 9.5k-block chunks for
NEW `EndpointRegistered` slugs; unions; multicalls `getEndpoint` for the full
set; returns `{ snapshots, scannedToBlock: finalizedNumber }`.
`readEndpointConfigs()` now = `(await readEndpointConfigsFrom(deploymentBlock)).snapshots`.

## Parallelized config-sync loop

`refreshAllNetworks` changed from sequential `for ... await` to
`Promise.allSettled(networks.map(refreshNetwork))`, preserving per-network
isolation (each path swallows + logs its own errors; the allSettled backstop
surfaces anything escaping) so one chain's failure neither delays nor aborts the
others.

## Cursor test results

`packages/indexer/test/on-chain-sync-cursor.service.spec.ts` (jest, mocked
adapter + mocked Prisma) — **3/3 pass**:
- cold start (no cursor) scans from `deploymentBlock` (42953139) and persists
  `scannedToBlock`.
- second pass resumes from `storedCursor + 1`, NOT `deploymentBlock`.
- threads the indexer's known slugs into the refresh set.

`packages/shared/test/evm-adapter-unit.test.ts` — +3 (now 15/15): scans from the
given fromBlock not deploymentBlock + returns scannedToBlock; refreshes
knownSlugs even with zero new logs; unions new + known.

(TDD: both sets written RED first — indexer 3 failed `is not a function`/no
cursor calls; shared 3 failed `readEndpointConfigsFrom is not a function` — then
GREEN.)

## Indexer suite results (pre-existing/env failures isolated)

`pnpm --filter @pact-network/indexer exec jest`:

```
Test Suites: 1 failed, 13 passed, 14 total
Tests:       4 failed, 91 passed, 95 total
```

- The **only** failing suite is `test/migration-rollback.spec.ts` (4 tests),
  failing with `Can't reach database server at localhost:5433` — pre-existing,
  needs a live Postgres, NOT mine (and NOT introduced by this change).
- All 91 non-DB tests pass, including: `events.service.spec` (finding-5,
  Solana-devnet stamping), `on-chain-sync.service.spec` (legacy-direct path
  9/9), `adapters.service`, `reorg.service`, controllers, `wire-compat`, `stats`.

## No-regression proof (other packages)

- `shared`: full suite **39/39** (contract/parity guards green); build clean.
- `db`: build clean (`prisma generate && tsc`, exit 0).
- `indexer`: build clean (`nest build`, exit 0).
- `settler` (consumes shared dist; rebuilt shared): full suite **92/92** —
  concurrency gate still **4/4**, Arc e2e still **8/8**.

## Notes / scope discipline

- Did NOT touch `on-chain-sync.service.ts:300` hardcoded `solana-devnet` — that
  is Task 6.
- No production-DB writes; migration SQL committed unapplied (no local DB).
- `gitnexus analyze` intentionally NOT run (worktree gotcha per `CLAUDE.md`).
- No emojis; pnpm only.
- Pre-existing EVM endpoint-slug storage shape (bytes16 hex vs `VarChar(16)`) is
  a separate concern (EVM endpoint-registration tooling is out of scope per the
  plan) and was left untouched.
