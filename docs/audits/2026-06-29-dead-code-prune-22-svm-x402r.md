# Dead-code / unused-exports prune — agent-tasks#22 (group 2: dead SVM / x402r escrow paths)

Date: 2026-06-29
Branch: `crew/prune-svm-x402r-22` (base: `origin/develop`)
Scope: Dead SVM / x402r escrow paths — the second removal group of the multi-PR #22 sweep.
Predecessor: `crew/prune-deadcode-22` (group 1) — removed `FetchOptions` from monitor and `isAddress`/`isHex` re-exports from sdk.

## Method

Same as group 1 (follow exactly):
1. `pnpm dlx knip --no-progress` workspace-wide + `pnpm dlx ts-prune` per target package to surface candidates.
2. knip's actionable signal = **unused exports / exported types**. Knip's "Unused files" list is dominated by false positives (test files, scripts, skill templates) — ignored.
3. Every candidate was **grep-proven across the WHOLE repo** (`packages scripts samples docs`, including all `*.test.ts` files) before any decision. In-module use or test import → KEEP. When unsure → KEEP.
4. **Pure removal only.** Unused `export` keywords on in-module-used symbols are de-export candidates (visibility change), not dead-code removal — out of scope.

## Frozen-legacy exclusions (not touched)

- `packages/program/programs/pact-insurance` (Anchor on-chain crate) — rollback fallback.
- `packages/insurance/` — active legacy client; `insurance/src/legacy-anchor-client.ts` intentionally kept.
- Insurance tests.
- No on-chain Rust changes.

## Removed (4 items — all zero-importer, grep-proven)

All four items are in `packages/backend/src/utils/solana.ts`. They are the old Anchor-based SVM client helpers from before the migration to `createKitSolanaClient` (the Kit-based replacement, introduced in WP-17). The Kit client is actively used by `premium-settler.ts`, `rate-updater.ts`, `pools.ts`, and `claim-settlement.ts`; the Anchor client had no callers left.

| # | Item | File | Kind | Zero-importer proof | Decision |
|---|------|------|------|---------------------|----------|
| 1 | `createSolanaClient` | `backend/src/utils/solana.ts:114` | dead function | `grep -rn "createSolanaClient" packages scripts samples` → **only** in: (a) its own definition, (b) a stale comment in `api.test.ts:802` that says "reaches createSolanaClient → RPC" (comment only, no import/call). Not used in-module. Uses old Anchor `AnchorProvider`/`Program`/`Wallet` client replaced by `createKitSolanaClient`. | **REMOVE** |
| 2 | `deriveProtocolPda` | `backend/src/utils/solana.ts:152` | dead function | `grep -rn "deriveProtocolPda" packages scripts samples` → only the definition. Other files define their own local versions (`seed-devnet-pools.ts:64`, `insurance/legacy-anchor-client.ts:43`) — none import from backend. Uses old `"protocol"` seed; v1 Pinocchio program uses `"protocol_config"` (`SEED_PROTOCOL_CONFIG`). | **REMOVE** |
| 3 | `deriveVaultPda` | `backend/src/utils/solana.ts:163` | dead function | `grep -rn "deriveVaultPda" packages scripts samples` → only the definition and `insurance/legacy-anchor-client.ts:57` (defines its own local copy). Backend version not imported by any consumer. Uses old `"vault"` seed — v1 program uses different seeds. | **REMOVE** |
| 4 | `deriveClaimPda` | `backend/src/utils/solana.ts:186` | dead function | `grep -rn "deriveClaimPda" packages scripts samples` → only the definition and `program/tests/security-hardening.ts:23` which defines its own LOCAL function of the same name (not an import from backend). Backend version not imported by any consumer. Uses old `"claim"` + policy PDA seed from the v2 Anchor insurance program. | **REMOVE** |

### Orphan cleanup from removal #1

Removing `createSolanaClient` orphaned the following (per Karpathy principle 3 — removed imports/vars made dead by the change):

- `import { AnchorProvider, Program, Wallet } from "@anchor-lang/core"` — only used in `createSolanaClient`.
- `import { fileURLToPath } from "url"` — only used for `__dirname`.
- `import { dirname, join } from "path"` — only used for `__dirname` and `idlJsonPath`.
- `Connection` from `import { Connection, Keypair, PublicKey } from "@solana/web3.js"` — only used in `createSolanaClient`; `Keypair` and `PublicKey` retained.
- `const __dirname = dirname(fileURLToPath(import.meta.url))` — only used for `idlJsonPath`.
- `const idlJsonPath = join(__dirname, "..", "idl", "pact_insurance.json")` — only used for `idl`.
- `const idl = JSON.parse(fs.readFileSync(idlJsonPath, "utf-8"))` — only used in `createSolanaClient`.
- Stale part of a comment referencing the Anchor client ("retained as a legacy fallback for the existing test suite").

`callIdSeedBytes` (was called by `deriveClaimPda` in-module) was **KEPT**: it is independently imported and tested in `backend/src/utils/claims.test.ts`.

## Inspected and KEPT (zero-importer but in-scope of methodology-mandated KEEP)

| Item | File | Why kept |
|------|------|----------|
| `stopCrank` | `backend/src/crank/index.ts:46` | Zero importers, not called in-module. Kept per "when unsure KEEP" — lifecycle/graceful-shutdown function; may be wired to a shutdown handler in a future PR. Not an SVM escrow path. |
| `COVERAGE_POOL_DISCRIMINATOR_BYTE` | `backend/src/crank/rate-updater.ts:35` | Used in-module at `:55` — de-export candidate only, not dead. |
| `quoteJson` | `dummy-upstream/src/app.ts:125` | Used in-module by `createApp` at `:359` — de-export candidate only. |
| `PAYAI_DEMO_AMOUNT_ATOMIC`, `usdcAsset`, `USDC_MINT`, `SOLANA_NETWORK`, `DEMO_PAY_TO`, `DEMO_MAX_AMOUNT_REQUIRED` | `dummy-upstream/src/x402-payai.ts`, `dummy-upstream/src/x402.ts` | ts-prune marks all as "(used in module)". De-export candidates, not dead code. |
| `SettleResponse`, `VerifyResponse` | `dummy-upstream/src/x402-payai.ts:150` | Imported from `x402-solana/server` and re-exported; ts-prune treats the re-export as "used in module". No external callers, but the re-export counts as in-module use per ts-prune. Kept conservatively. |
| Fraud-detection functions (`getFailureRates`, `countEstablishedFailingAgents`, `upsertLoadingFactor`, `createFlag`, `recordOutageEvent`) | `backend/src/utils/fraud-detection.ts` | Used in-module per ts-prune "(used in module)" mark. |
| All `shared`, `classifier`, `wrap`, `monitor`, `sdk` knip candidates | Various | Already audited in group 1; conclusions unchanged — all used in-module or imported by tests. |

## x402r scope note

The task's "x402r escrow paths" label: the dummy-upstream `x402.ts` and `x402-payai.ts` files (which implement the x402 payment/refund path) were inspected but contain **no dead code** — all exports are used in-module within `app.ts` or in `buildRequirements`/`makeX402Handler`. No removals from these files.

## Verification

- `pnpm install && pnpm -r build` → **exit 0** (all packages type-checked in topo order).
- `cd packages/backend && pnpm exec tsx --test src/utils/*.test.ts` → **61 tests, 0 failures, 0 cancelled**. Includes `callIdSeedBytes (H-02 lock-in)` (the only function whose in-module caller `deriveClaimPda` was removed; the function itself is kept and tested).
- Routes/sandbox tests were not run — they require Postgres (ECONNREFUSED); the diff touches no code they exercise.

Part of agent-tasks#22.
