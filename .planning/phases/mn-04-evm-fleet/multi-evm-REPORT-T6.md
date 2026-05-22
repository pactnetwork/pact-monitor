# Multi-EVM WP — Task 6 Report (legacy-direct hardcoded network fix)

**Branch:** `feat/concurrent-multi-evm`
**Commit:** `c8385ce` — `fix(indexer): stamp resolved Solana network on legacy-direct sync (multi-evm WP T6)` (2 files, +97 / -4)
**Status:** DONE. Legacy-direct Solana sync now stamps the enabled network; zero regressions (DB-needing `migration-rollback.spec` x4 env failures isolated).

## The bug

`on-chain-sync.service.ts` `upsertOne()` hardcoded `const syncNetwork = "solana-devnet"` on the legacy-direct path (`refreshLegacyDirect -> syncEndpointsFromChain -> upsertOne`). A `solana-mainnet` legacy deploy (`PACT_LEGACY_DIRECT_SOLANA=true`, mainnet RPC) mislabeled every Endpoint row as `solana-devnet`.

## The fix

Resolve the Solana network from the enabled networks instead of the literal:

- Added `resolveLegacySolanaNetwork()` — returns the single enabled `solana-*`
  network from `adaptersService.listEnabledNetworks()`, defaulting to
  `"solana-devnet"` only if none is enabled (defensive; legacy-direct implies
  one is).
- `syncEndpointsFromChain()` resolves it once per pass and threads it into
  `upsertOne(acct, syncNetwork)`.
- `upsertOne` now takes `syncNetwork` and uses it for the `where`/`create.network`
  (the hardcoded literal is gone).

Scope honored: ONLY the legacy-direct path changed. The adapter path
(`refreshViaAdapter` / `refreshViaAdapterWithCursor`) and the T3 cursor code were
NOT touched.

```diff
-    const syncNetwork = "solana-devnet";
+    // syncNetwork resolved once per pass via resolveLegacySolanaNetwork()
-  private async upsertOne(acct): Promise<string | null> {
+  private async upsertOne(acct, syncNetwork: string): Promise<string | null> {
+  private resolveLegacySolanaNetwork(): string {
+    const solana = this.adaptersService.listEnabledNetworks()
+      .find((n) => n.startsWith("solana-"));
+    return solana ?? "solana-devnet";
+  }
```

## Test (TDD: RED first)

Added `describe("OnChainSyncService — legacy-direct network resolution (multi-evm WP T6)")` to `test/on-chain-sync.service.spec.ts`:

- stamps rows with the enabled Solana network (`solana-mainnet`), not
  `solana-devnet` — **was RED** (got `solana-devnet`), now GREEN.
- still stamps `solana-devnet` when that is the enabled Solana network
  (backward-compat) — GREEN.

RED proof before the fix: `1 failed, 10 passed` — the mainnet test failed with
`Expected "solana-mainnet" / Received "solana-devnet"`. After the fix: both pass.

The existing legacy-direct tests (empty chain, single/five endpoints, RPC-error,
isRunning guard, paused-bit mapping) still use `listEnabledNetworks: () =>
["solana-devnet"]` and stay green.

## Indexer suite results (pre-existing/env failures isolated)

`pnpm --filter @pact-network/indexer exec jest`:

```
Test Suites: 1 failed, 13 passed, 14 total
Tests:       4 failed, 93 passed, 97 total
```

- The **only** failing suite is `test/migration-rollback.spec.ts` (4 tests),
  failing with `Can't reach database server at localhost:5433` — pre-existing,
  needs a live Postgres, NOT mine.
- Focused runs: `on-chain-sync` (cursor + sync spec) **14/14**;
  `events` (finding-5) **21/21**. Test count rose 95 -> 97 (the 2 new T6 tests).
- `pnpm --filter @pact-network/indexer build` (`nest build`) — clean (exit 0).

## Notes / scope discipline

- Legacy-direct path only; adapter path + T3 cursor untouched.
- No production-DB writes. No emojis; pnpm only.
- `gitnexus analyze` intentionally NOT run (worktree gotcha per `CLAUDE.md`).
- This completes the multi-EVM WP tasks assigned to crew-1 (T0, T1, T2, T3, T6).
  T4 (EVM signer gas-balance monitoring) and T5 (settler EVM-only boot) were not
  assigned to this crew.
