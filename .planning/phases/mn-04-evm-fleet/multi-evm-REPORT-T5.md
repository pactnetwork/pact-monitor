# Multi-EVM WP — Task 5 Report (settler boots without Solana)

**Branch:** `feat/concurrent-multi-evm`
**Commits:** `8d9241c` (SubmitterService) + `26c02ac` (REDO — two more boot blockers + real-config boot test)
**Status:** DONE (after redo). EVM-only settler boots through ALL boot-path
providers without `SOLANA_RPC_URL` / `SETTLEMENT_AUTHORITY_KEY`; Solana path
unchanged when enabled; full settler suite 107/107.

---

## REDO (T5 rejected as incomplete — two more boot blockers)

The first T5 fixed `SubmitterService` but a real EVM-only boot still crashed: two
OTHER providers hard-required Solana env at DI/boot. Root cause of the miss: the
first T5 test instantiated `SubmitterService` alone with a MOCKED ConfigService,
so it never fed a real config through the other providers.

**Blocker 1 — `signer-balance.service.ts` (constructor):**
`getOrThrow("SOLANA_RPC_URL")` + `new Connection(rpc)` ran during construction.
This was MY T4 code. Fixed: derive `solanaEnabled` from `PACT_ENABLED_NETWORKS`;
build the Connection only when a solana-* network is enabled (else `connection =
null`); `pollSolana()` early-returns on EVM-only while `pollEvmSigners()` still
runs. Added `get solanaMonitored()`.

**Blocker 2 — `secret-loader.service.ts` (onModuleInit -> load()):**
`getOrThrow("SETTLEMENT_AUTHORITY_KEY")` + `Keypair.fromSecretKey` ran at boot.
Fixed: `onModuleInit` skips `load()` on EVM-only (the EVM signer comes from
`PACT_SETTLER_KEYPAIR_<NETWORK>` via AdaptersService, not from here). `load()`
itself is unchanged (existing tests call it directly); the `keypair` getter still
throws if accessed.

**Consequential fix — `health.controller.ts`:** gating `pollSolana` leaves
`currentLamports = UNKNOWN_BALANCE (-1)`, which made `/health` return **503
forever** on an EVM-only settler (Cloud Run would deroute it — boots but dead).
Added: when `!balance.solanaMonitored`, `/health` returns 200 `ok` (EVM signer
gas is warn/alert-only per T4 — there is no Solana signer to gate on). This was
beyond the two named blockers but is required for an EVM-only settler to actually
serve; flagged here for review.

**DRY:** all three providers (+ the original SubmitterService, refactored) now
gate via one helper `config/enabled-networks.ts` `hasSolanaNetwork()` — single
source of truth matching the AdaptersService bootstrap (default `solana-devnet`).

### REAL-config boot test (acceptance)

`packages/settler/test/evm-only-boot.spec.ts` (3 tests, all green):
- **boots all providers EVM-only with no SOLANA_RPC_URL / SETTLEMENT_AUTHORITY_KEY**
  — deletes both env keys, wires the REAL `@nestjs/config` ConfigService (reads
  process.env, NOT a mock) into the REAL AdaptersService + SecretLoaderService +
  SignerBalanceService + SubmitterService, and runs every constructor +
  onModuleInit; asserts no throw + that the config genuinely lacks both keys.
- **EVM-only health is OK (not 503)** — drives the real HealthController.
- **still fails fast at construction when Solana enabled but SOLANA_RPC_URL
  missing** — regression.

Note on harness: the settler runs vitest/esbuild, which does NOT emit
`design:paramtypes` decorator metadata, so Nest's injector cannot resolve
constructor params in-process (every existing settler test instantiates providers
directly). The boot test therefore wires the REAL ConfigService over process.env
into the real providers manually — crossing the identical config -> construct ->
onModuleInit seam the blockers live on, with NO mocked config. The full Nest
injector is exercised by the nest-built `node dist/main.js` boot (nest-build emits
metadata) — the captain's empirical check.

RED proof before the redo fix: 4 failed (signer-balance EVM-only, secret-loader
EVM-only, 2 boot-test cases). After: all green.

### Boot-path completeness sweep

`grep` confirms the ONLY Solana `getOrThrow`/`new Connection` on the boot path
are now inside `solanaEnabled` guards (signer-balance constructor; submitter
`solana()`); `SETTLEMENT_AUTHORITY_KEY` is gated via secret-loader
`onModuleInit`. The other boot getOrThrows (`INDEXER_URL`, `INDEXER_PUSH_SECRET`,
`REDIS_URL`/`PUBSUB_*`) are network-agnostic, required for any settler.

### Redo verification

- Full settler suite: **107/107** (15 files) — gate **4/4**, arc **8/8**,
  `signer-balance` (incl EVM-only + Solana) green, `secret-loader` green,
  `submitter.service` **10/10**, `evm-only-boot` **3/3**, Solana guards green.
- `pnpm --filter @pact-network/settler build` clean (exit 0).
- Did NOT modify the multi-evm-concurrency gate test.

---

## Original T5 (SubmitterService) — retained below

**Status:** DONE. EVM-only settler boots without `SOLANA_RPC_URL`; Solana path unchanged when enabled; zero regressions.

## Impact analysis (manual — GitNexus has no pact-network index)

`SubmitterService` constructor signature is UNCHANGED `(config, secrets,
adaptersService)`. The six Solana fields (connection, programId, usdcMint,
settlementAuthorityPda, treasuryPda, protocolConfigPda) were folded into a
lazily/eagerly-built `SolanaContext` bundle accessed via `this.solana()`.
Dependents (all construct with Solana enabled, so unaffected):

- `submitter.service.spec` (constructs + uses derived getters) — default config
  has `SOLANA_RPC_URL` + defaults to `solana-devnet`.
- `arc-testnet-settle-e2e` (`buildSubmitter`) — config sets `SOLANA_RPC_URL`,
  `PACT_ENABLED_NETWORKS="arc-testnet"`... see note below.
- `multi-evm-concurrency` gate — `PACT_ENABLED_NETWORKS="arc-testnet,evm-test-2"`
  (no solana) -> now boots EVM-only, skips Treasury preload; its EVM submit path
  never calls `this.solana()`. Gate stays 4/4 (NOT modified).
- `pipeline.e2e`, `adapter-swap-e2e` (Solana guards) — solana enabled.

Note: `arc-testnet-settle-e2e`'s submitter is built with
`PACT_ENABLED_NETWORKS="arc-testnet"` (no solana) but its config DOES set
`SOLANA_RPC_URL` and it mocks `@solana/web3.js`. With this change it now boots
EVM-only (skips the Treasury preload it previously warned on) — still 8/8, since
that suite's settle assertions all run through the EVM adapter path.

## The change (conditional + lazy)

A `SolanaContext` bundle (RPC `Connection` + program PDAs) built by a single
private `solana()` builder that memoises into `this.solanaCtx`:

- **Constructor:** derives `solanaEnabled` from `PACT_ENABLED_NETWORKS` (default
  `solana-devnet`, so existing deploys are unaffected) =
  `enabled.some(n => n.startsWith("solana"))`. If a Solana network is enabled it
  calls `this.solana()` EAGERLY so a missing `SOLANA_RPC_URL` still fails fast at
  construction — exactly as today. If NO solana-* network is enabled it builds
  nothing and logs an EVM-only-boot line (no `getOrThrow("SOLANA_RPC_URL")`, no
  `Connection`, no PDAs).
- **`onModuleInit`:** returns early (skips the Treasury preload) when
  `!solanaEnabled`; otherwise unchanged.
- **Solana-only methods** (`submitLegacyDirect`, `loadEndpoint`,
  `loadTreasuryVault`, `findExistingCallRecordSignature`) and the derived PDA
  getters now read the bundle via `const { ... } = this.solana()` — the same
  values as before. They are only reachable on a Solana route (which implies the
  bundle is built); on an EVM-only settler they are never called, and would
  throw a clear error if they were.

The legacy-direct Solana submit path (`submitLegacyDirect`, gated on
`network.startsWith("solana-")`) is byte-identical when Solana is enabled — only
`this.<field>` was replaced with the destructured local of the same value.

## Tests (TDD: RED first)

`packages/settler/src/submitter/submitter.service.spec.ts` — new describe
`SubmitterService — boot without Solana (multi-evm WP T5)`:

- **boots EVM-only (no solana-* enabled) without requiring SOLANA_RPC_URL** —
  config whose `getOrThrow` throws for EVERY key + `PACT_ENABLED_NETWORKS=
  "arc-testnet"`; asserts construction + `onModuleInit()` resolve and
  `getOrThrow` was never called with `"SOLANA_RPC_URL"`. (This is the EVM-only
  boot proof.)
- **still builds the Solana path when a Solana network is enabled (default)** —
  regression: the derived PDA getters are defined.
- **still fails fast at construction when Solana is enabled but SOLANA_RPC_URL is
  missing** — regression: constructor throws `/SOLANA_RPC_URL/`.

RED proof before impl: `1 failed | 9 passed` — the EVM-only boot test failed
(constructor's unconditional `getOrThrow("SOLANA_RPC_URL")` threw); the two
regression tests passed. After impl: `10 passed`.

## Full settler suite proof (gate 4/4, Arc 8/8)

`pnpm --filter @pact-network/settler test`:

```
 Test Files  14 passed (14)
      Tests  101 passed (101)
```

(was 98 -> 101 with the 3 new T5 tests.) Includes `multi-evm-concurrency` gate
**4/4**, `arc-testnet-settle-e2e` **8/8**, `submitter.service` **10/10**,
`signer-balance` **18/18**, and the Solana guards `adapter-swap-e2e` +
`pipeline.e2e` — all green. `pnpm --filter @pact-network/settler build`
(`nest build`) clean (exit 0).

## Notes / scope discipline

- Did NOT modify the gate test or any T0-T4/T6 code. No call-site/signature
  changes (constructor params unchanged).
- Empirical `node dist/index.js` EVM-only boot is a full-app/Cloud-Run concern
  (needs Pub/Sub + env Rick owns); the submitter was the boot blocker and the
  unit test proves it boots EVM-only. The captain's final-gate empirical boot can
  run in the deploy environment.
- `gitnexus analyze` intentionally NOT run (worktree gotcha per `CLAUDE.md`).
- No emojis; pnpm only.
- This is the LAST code task — crew-1 has now delivered T0, T1, T2, T3, T4, T5,
  T6 of the multi-EVM WP.
