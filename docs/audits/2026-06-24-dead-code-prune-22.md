# Dead-code / unused-exports prune — agent-tasks#22 (group 1)

Date: 2026-06-24
Branch: `crew/prune-deadcode-22` (base: `origin/develop`)
Scope: **dead-code / unused-exports sweep only**, one removal group of the multi-PR #22 sweep.
Named target packages (issue #22): `shared`, `classifier`, `wrap`, `monitor`, `sdk`.

## Method

1. `pnpm dlx ts-prune` per target package + `pnpm dlx knip --no-progress` workspace-wide to surface candidates.
2. ts-prune over a library package flags every public-API re-export from `index.ts` (consumed cross-package) — those are **not** dead. knip is workspace-aware, so it is the primary signal; but knip has **no config** in this repo, so its "Unused files / dependencies" output is dominated by false positives (it flags every `*.test.ts` / `*.spec.ts` / script as unused). Those were **ignored**.
3. The only actionable knip signal = **unused exports / exported types / enum members**. Every candidate was then **grep-proven across the WHOLE repo** (`packages scripts samples docs`, including each package's own dir and test files) before any decision. This guards against the PR #276 regression (which broke by excluding in-package test importers).
4. **Pure removal only.** When a symbol was used in-module or imported by a test, it was **KEPT** (only its `export` keyword would be "unused", which is a reduce-visibility change, not dead-code removal — out of scope). When unsure, KEEP.

## Frozen-legacy exclusions (not touched)

- `packages/program/programs/pact-insurance` (Anchor crate) — rollback fallback.
- `packages/shared/src/legacy-anchor-client.ts` — intentional; imported on purpose by `insurance/client.test.ts` and program tests. (Note: this file does not currently exist under `packages/shared/src`; nothing to exclude in practice — listed for completeness.)
- `insurance/*` tests.

## Removed (2 items — both zero-importer, proven)

| # | Item | Package | Kind | Zero-importer proof | Decision |
|---|------|---------|------|---------------------|----------|
| 1 | `FetchOptions` interface | `monitor` (`src/types.ts:55`) | unused exported type | `grep -rnw FetchOptions packages scripts samples docs` → **only** the definition line. `monitor/src/index.ts` re-exports an explicit list (`CallRecord, Classification, PaymentData, PactConfig, PactFetchOptions, ExpectedSchema`) with **no `export *` wildcard** — `FetchOptions` is not among them, so it is unreachable via the package's public entry (`dist/index.js`) and unused in-module. It is the dead sibling of the actually-used `PactFetchOptions`. | **REMOVE** |
| 2 | `export { isAddress, isHex }` re-export + orphaned `isAddress` import | `sdk` (`src/signer.ts:150-151`, import `:24`) | unused re-export | `sdk/src/index.ts` re-exports only 6 type names from `signer.js` (`EvmPactSigner, PactSigner, SignFn, SolanaPactSigner, Vm, WalletAdapterSigner`) — **not** `isAddress`/`isHex`. `package.json` `exports` map exposes only `"."` (no `./signer` subpath), so deep imports are blocked for external consumers. No file in the repo imports `isAddress`/`isHex` from sdk. `isAddress` was used **only** in this re-export; `isHex` is used in-module at `:114` and `getAddress` at `:86` (both kept in the import). Comment ("callers may need…") confirms speculative export with zero callers. | **REMOVE** |

### Orphan cleanup from removal #2
Removing the re-export left `isAddress` unused in the `viem` import on `signer.ts:24`; it was dropped from the import (`getAddress`, `isHex` retained). This is the only orphan created by the change (karpathy principle 3).

## Inspected and KEPT (not dead — would have been the PR #276 trap)

All of the following were knip "unused export" candidates but grep proved an in-module use or a **test import**, so they are NOT dead:

| Item | Package | Why kept |
|------|---------|----------|
| `MAX_MANUAL_USDC_PER_CALL` | monitor `payment-extractor.ts` | used in-module (`:75,:77`); referenced by tests by name |
| `NETWORK_CONFIGS` | sdk `network.ts` | used in-module (`:94`) + `network.test.ts` imports it |
| `ObservationBuffer` | sdk `observation-buffer.ts` | imported by `observation-buffer.test.ts` and `indexer-poller.test.ts` |
| `buildCreateAtaIdempotentIx` | sdk `on-chain.ts` | used in-module (`:145`) + `on-chain.test.ts` imports it |
| `buildSignaturePayload` | sdk `proxy-transport.ts` | used in-module (`:107`) + `proxy-transport.test.ts` imports it |
| `isNodeFsAvailable` | sdk `storage-select.ts` | used in-module (`:28`) + `storage.test.ts` imports it |
| `safeBig` | sdk `storage.ts` | used in-module (`:61,:62`) — export technically unused externally, but used-in-module ⇒ not dead |
| `DegradedReason` | sdk `golden-fetch.ts` | used in-module (`:46,:151,:164`) |
| `RefundEventData`, `BilledEventData` | sdk `indexer-poller.ts` | used in-module (`:58,:59`) |
| `NetworkConfig` | sdk `network.ts` | used in-module (`:48,:78`) |
| `DiscoveryEndpoint`, `DiscoveryResponse` | sdk `slug-resolver.ts` | used in-module + `slug-resolver.test.ts` imports `DiscoveryResponse` |
| `PactErrorCode` members `ATA_NOT_FOUND`, `ALLOWANCE_INSUFFICIENT`, `BALANCE_INSUFFICIENT`, `PROXY_UNREACHABLE`, `SIGNATURE_FAILED`, `DISCOVERY_FAILED` | sdk `errors.ts` | zero code references, BUT they are members of the **published SDK's documented error-taxonomy contract** (each has explanatory JSDoc; the file docblock describes the design). Removing public enum members = behavior/API change, not dead-code removal. KEEP per "NO behavior changes" + "when unsure KEEP". |

`shared`, `classifier`, `wrap`: knip found **zero** in-package unused exports — every export has a cross-package consumer. Nothing removed (conservative, correct).

## Verification

- `pnpm -r build` → **exit 0** (all packages type-checked in topo order).
- Tests (one-shot `vitest run`, no coverage): `shared` 54, `classifier` 77, `wrap` 95, `monitor` 53, `sdk` 139 (+1 skipped) — all **green**.
- Infra-dependent e2e specs (settler/indexer, require Postgres/network) were not run, per crew freeze-safety discipline; the diff touches no code they exercise.

## NOTED follow-up groups for later #22 PRs (NOT actioned here)

1. **Dead SVM / x402r escrow paths** — separate removal group.
2. **dummy-upstream / devnet leftovers** — e.g. `dummy-upstream/src/x402*.ts` exports flagged by knip (`USDC_MINT`, `DEMO_PAY_TO`, `PAYAI_DEMO_AMOUNT_ATOMIC`, …); needs domain review.
3. **program vs program-evm orphaned instructions/accounts** — separate group.
4. **Unused dependencies / devDependencies** (knip: 22 deps + 42 devDeps) — high false-positive rate without a knip config (many are used via scripts/test runners: `tsx`, `vitest`, `prisma`, …). Should be a dedicated, carefully-verified dependency-prune PR, not bundled with code removal.
5. **De-export (reduce-visibility) candidates** — symbols used in-module but unnecessarily `export`ed (`monitor` `MAX_MANUAL_USDC_PER_CALL`; `sdk` `safeBig`, `DegradedReason`, `RefundEventData`, `BilledEventData`, `NetworkConfig`, `DiscoveryEndpoint`). These are not dead code; de-exporting is a visibility refactor — defer.
6. **`PactErrorCode` unused members** — if product confirms they are not part of the external contract, a follow-up can prune them; treat as an API-contract decision, not dead code.
7. **Duplicate export** `PROGRAM_ID_DEVNET | ORPHAN_PROGRAM_ID_DEVNET_STEP_C` in `protocol-v1-client/src/constants.ts` (knip "Duplicate exports") — review separately.
8. **Add a `knip.json`** so future sweeps stop drowning in test/script false positives.

Part of agent-tasks#22.
