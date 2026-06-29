# Dead-code / unused-exports prune — agent-tasks#22 (group 2: dummy-upstream / devnet leftovers)

Date: 2026-06-29
Branch: `crew/prune-dummy-devnet-22` (base: `origin/develop`)
Scope: **dummy-upstream x402 export candidates** — the group flagged as "needs domain review" in the group-1 audit (2026-06-24-dead-code-prune-22.md).
Named targets: `packages/dummy-upstream/src/x402.ts`, `packages/dummy-upstream/src/x402-payai.ts`.

## Method

Same as group 1 (see 2026-06-24-dead-code-prune-22.md for full methodology description):

1. List every `export` in the target files.
2. For each candidate: grep-prove across the **whole repo** (`packages scripts samples docs`, including test files) — no matches outside `dummy-upstream/src/` = potential dead export.
3. Then check in-module usage: if the symbol is used anywhere in the same file, the `export` keyword is only a reduce-visibility candidate, not dead code. Per group-1 precedent, de-exporting is out of scope — those are KEPT.
4. **Pure removal only.** When unsure, KEEP. Demo fixtures get extra conservatism per task brief.

## Frozen-legacy exclusions

Same as group 1: `packages/program/programs/pact-insurance`, `packages/shared/src/legacy-anchor-client.ts`, `insurance/*` tests. None of these are relevant to this scope.

## Exported symbols — `src/x402.ts`

| Symbol | Kind | In-module use? | Cross-package importers | Decision |
|--------|------|---------------|------------------------|----------|
| `USDC_MINT` | const | Yes — consumed by `buildX402Accept` (line 75) | 0 | **KEEP** — in-module use |
| `SOLANA_NETWORK` | const | Yes — consumed by `buildX402Accept` (line 74) | 0 | **KEEP** — in-module use |
| `DEMO_PAY_TO` | const | Yes — consumed by `buildX402Accept` (line 76) | 0 | **KEEP** — in-module use |
| `DEMO_MAX_AMOUNT_REQUIRED` | const | Yes — consumed by `buildX402Accept` (line 77) | 0 | **KEEP** — in-module use |
| `X402Accept` | interface | Yes — parameter type of `encodeAcceptHeader`, return type part of `buildX402Accept` | 0 | **KEEP** — in-module use |
| `X402Challenge` | interface | Yes — return type of `buildX402Challenge` | 0 | **KEEP** — in-module use |
| `buildX402Accept` | function | Yes — called by `buildX402Challenge` | `src/app.ts` imports it | **KEEP** — active |
| `buildX402Challenge` | function | No (defined, not self-called) | `src/app.ts` imports it | **KEEP** — active |
| `encodeAcceptHeader` | function | No (defined, not self-called) | `src/app.ts` imports it | **KEEP** — active |

## Exported symbols — `src/x402-payai.ts`

| Symbol | Kind | In-module use? | Cross-package importers | Decision |
|--------|------|---------------|------------------------|----------|
| `PAYAI_DEMO_AMOUNT_ATOMIC` | const | Yes — `amount` field in `buildRequirements` (line 139) | 0 | **KEEP** — in-module use |
| `PayAIConfig` | interface | Yes — parameter/return types of `payAIConfigFromEnv`, `makeX402Handler` | 0 | **KEEP** — in-module use |
| `payAIConfigFromEnv` | function | No (not self-called) | `src/app.ts` imports it | **KEEP** — active |
| `makeX402Handler` | function | No (not self-called) | `src/app.ts` imports it (`type X402PaymentHandler` also imported) | **KEEP** — active |
| `usdcAsset` | function | Yes — called by `buildRequirements` (line 141) | 0 | **KEEP** — in-module use |
| `buildRequirements` | function | No (not self-called) | `src/app.ts` imports it | **KEEP** — active |
| `PaymentRequirements` | re-exported type | Yes — return type of `buildRequirements` (line 136) | 0 | **KEEP** — in-module use |
| `SettleResponse` | re-exported type | No — only in import+re-export passthrough | 0 | **KEEP** — demo surface; reduce-visibility only (out of scope per group-1 precedent) |
| `VerifyResponse` | re-exported type | No — only in import+re-export passthrough | 0 | **KEEP** — demo surface; reduce-visibility only (out of scope per group-1 precedent) |
| `X402PaymentHandler` | re-exported type | No (not used in function bodies) | `src/app.ts` imports it | **KEEP** — active |

## Cross-package consumer check

`packages/dummy-upstream` is `private: true` with no workspace consumers: `grep -r "@pact-network/dummy" packages scripts samples docs` returns only the package's own files and documentation references. No other package imports from it. The x402*.ts modules are entirely internal to dummy-upstream.

## Verdict: Nothing safely removable

Every exported symbol is either:
- **Used in-module** (in-function-body, not just re-export passthrough) → export is a reduce-visibility candidate, not dead code, per group-1 methodology; out of scope.
- **Imported by another file within the package** (`src/app.ts`, `api/index.ts`, or `test/app.test.ts`) → active.

`SettleResponse` and `VerifyResponse` are the only symbols with zero in-module use and zero cross-package consumers, but they are part of a coherent type re-export block in a demo-fixture file, and dropping them is a visibility refactor (same classification as the `sdk` reduce-visibility candidates deferred in group 1). Given the "extra conservative on demo fixtures" instruction, they are KEPT.

## Demo surface note

`dummy-upstream` is a **live deployed service** at `https://dummy.pactnetwork.io` (Vercel, confirmed in README). The x402*.ts files implement the service's core demo capability. They are not dead code by any definition — they are the whole feature. The knip "unused export" signal here simply reflects the fact that a deployed Hono service's internal modules are not consumed as a library by the rest of the monorepo, which is expected and correct.

## Verification

No code was changed; no build or test run required for a no-op audit commit. The prior group-1 verification (`pnpm -r build` exit 0, all affected package tests green) remains the last known-good baseline.

## Follow-up notes

- `SettleResponse` and `VerifyResponse` remain on the de-export deferred list from group 1 — if a future audit explicitly targets reduce-visibility changes, these are safe candidates.
- No additional devnet-leftover candidates were identified in the broader scan (`scripts/devnet/`, `packages/program/scripts/`) — those are active operational scripts, not dead code.

Part of agent-tasks#22.
