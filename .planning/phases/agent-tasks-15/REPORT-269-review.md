# Adversarial Read-Only Review — PR #269

- **Branch:** `fix/fs9-devnet-declare-id-15` → base `develop` (origin: pactnetwork/pact-monitor)
- **Reviewer:** crew/review-269 (read-only; no source modified, no merge/push/deploy)
- **Date:** 2026-06-15
- **Scope of diff:** 5 files, +63/−3 — all FS9 (agent-tasks#15)
  - `packages/program/programs-pinocchio/pact-network-v1-pinocchio/Cargo.toml`
  - `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/lib.rs`
  - `packages/protocol-v1-client/src/constants.ts`
  - `packages/sdk/src/network.ts`
  - `packages/sdk/src/__tests__/network.test.ts`

---

## A) VERDICT: 🟢 GREEN

The `devnet-id` cargo feature is **OFF by default** and is **not referenced by any
automated build path** (CI, smoke, mainnet deploy). Both binaries were rebuilt and
byte-decode-verified: the default build emits the mainnet id and *only* the mainnet
id; the `devnet-id` build emits the devnet id and *only* the devnet id. A devnet-id
binary cannot reach a mainnet deploy through any path in the repo. TS env override is
browser-safe, null-by-default, mainnet-isolated. No mainnet regression. SOL-01 intact.
Two non-blocking observations (G) — neither gates merge.

---

## B) devnet-id LEAK AUDIT — every build invocation, SAFE/UNSAFE

`grep -rn devnet-id` across `.github/`, `scripts/`, `packages/program/`, `docs/`:
the token appears **only** in `Cargo.toml:17` (feature decl) and `lib.rs:30-36`
(comment + cfg gates). **No build invocation anywhere passes `devnet-id`.** It is
manual-opt-in only.

Feature default — `Cargo.toml:14` `default = []` → `devnet-id` NOT in defaults.
No `[features]` entry transitively enables it; no workspace feature unification can
reach it (it is a leaf feature on a single crate, depended on by nothing).

| # | Build invocation | Features | Result | Verdict |
|---|---|---|---|---|
| 1 | `scripts/mainnet/deploy-program.sh:217` (mainnet v1 deploy) | `bpf-entrypoint` | mainnet `5bCJ` branch | **SAFE** — also source-guards `declare_id == 5bCJ` at `:150-156` before building (`head -1` reads the physically-first `#[cfg(not(...))]` line = 5bCJ; lib.rs:34-35) |
| 2 | `.github/workflows/program-build.yaml:78` (mainnet artifact) | `bpf-entrypoint` | builds **v2** crate (`pact-network-v2-pinocchio`), not the v1 crate this PR touches | **SAFE** (n/a to v1) |
| 3 | `.github/workflows/program-build.yaml:127` (test artifact) | `bpf-entrypoint,unsafe-bypass-deployer` | builds **v2** crate | **SAFE** (n/a; no devnet-id) |
| 4 | `packages/program/.../pact-network-v1-pinocchio/package.json:6` (`pnpm build`) | `bpf-entrypoint` | mainnet `5bCJ` branch | **SAFE** |
| 5 | `scripts/smoke-tier2/01-deploy.sh:88` (surfpool smoke) | `bpf-entrypoint` | sed-rewrites declare_id to a *local test* pubkey first, builds, reverts via `trap` (`:70-82`) | **SAFE** — devnet-id never used; revert trap intact |
| 6 | `CLAUDE.md:92`, `docs/mainnet-launch-checklist.md:164`, `scripts/mainnet/README.md:103` (docs) | `bpf-entrypoint` | doc text | **SAFE** |

Conclusion: **no path — default, CI, smoke, or mainnet — ever passes `devnet-id`.**
The only way to produce a 5jBQ binary is a human typing `--features ...,devnet-id`.

---

## C) BOTH-BUILDS VERIFY (rebuilt locally, cargo-build-sbf 3.1.13)

| Build | Command | Size | Base58→32B decoded id present | Other id present |
|---|---|---|---|---|
| default (mainnet) | `cargo build-sbf --features bpf-entrypoint` | 89,560 B | `5bCJ…` (`443146be…251b`) **PRESENT** | `5jBQ…` **ABSENT** |
| devnet-id | `cargo build-sbf --features bpf-entrypoint,devnet-id` | 89,560 B | `5jBQ…` (`463ce898…3f76`) **PRESENT** | `5bCJ…` **ABSENT** |

- Method: base58-decoded each id to 32 bytes, contiguous-byte search of each `.so`.
  `declare_id!` lays the id down contiguously in `.rodata` (unlike `from_str_const`,
  per the workflow note at `program-build.yaml:71-77`), so the grep is conclusive.
- Binaries differ in 532 of 89,560 bytes (md5 `ebafa8de…` vs `673757926…`) — the
  feature genuinely re-links the id const; not a no-op despite fast incremental build.
- `lib.rs:34-37`: exactly two `declare_id!`, mutually exclusive
  `#[cfg(not(feature="devnet-id"))]` / `#[cfg(feature="devnet-id")]`. Exactly one
  compiles per config. ✓

---

## D) TS ENV SAFETY + TEST COUNTS

`resolveDevnetProgramId()` — `constants.ts:60-67`:
- Browser-safe: `typeof process !== "undefined"` guard → `undefined` in browser. ✓
- Null when unset: `process.env?.PACT_DEVNET_PROGRAM_ID` (optional chaining), then
  `trimmed ? new PublicKey(trimmed) : null` → **null, no throw** when unset/empty. ✓
- Validates pubkey: `new PublicKey(trimmed)` throws on malformed opt-in input
  (fail-loud — see G2). ✓
- `network.ts:62`: `programId: resolveDevnetProgramId()?.toBase58() ?? null` — devnet
  only; evaluated at module load. mainnet (`network.ts:50` `PROGRAM_ID.toBase58()`)
  and localnet (`:71` `null`) untouched. ✓

Tests:
- `@q3labs/pact-protocol-v1-client`: **89 passed / 89** (5 files).
- `@q3labs/pact-sdk`: **139 passed, 1 skipped / 140** (17 files); `network.test.ts`
  **7/7**, incl. new "devnet picks up PACT_DEVNET_PROGRAM_ID env override (FS9 opt-in)"
  which also asserts mainnet stays `5bCJ`.
- (Note: `@q3labs/pact-monitor` has 3 pre-existing failures — `ERR_MODULE_NOT_FOUND`
  for `@pact-network/classifier/dist` build artifact — **unrelated to this PR**, a
  monorepo build-order issue; PR #269 does not touch monitor.)

---

## E) MAINNET-REGRESSION CHECK

- `PROGRAM_ID = 5bCJ…` (`constants.ts:22-24`): **unchanged** — not in diff. The two
  `5bCJ` strings in the diff are a *comment* (`lib.rs:33`) and a *test assertion*
  (`network.test.ts`), neither alters the constant.
- `USDC_MINT_MAINNET` (`constants.ts:98`): **unchanged** — not in diff.
- `NETWORK_CONFIGS.mainnet` (`network.ts:49-55`): **unchanged** — not in diff.
- mainnet `declare_id!` branch builds to `5bCJ` by default (verified C). ✓

No mainnet behavior changed.

---

## F) SOL-01 (#245) PRESENT

- `settle_batch.rs:125`: `verify_settlement_authority(settlement_auth)?;` — called
  before reading `signer`/`bump` (comment `:120-124`).
- `pda.rs:91-101` `verify_settlement_authority`: derive-check
  (`account.address() != &expected` → `InvalidSettlementAuthority`) **AND** owner-check
  (`!account.owned_by(&ID)` → `InvalidSettlementAuthority`). Both present. ✓
- Not regressed by this PR (PR does not touch settle_batch.rs / pda.rs).

---

## G) SLOP / SCOPE / BLOCKING

No scope creep — 5 files, all FS9. No drive-by refactors, no dead code.

Non-blocking observations:
1. **(LOW, incompleteness) `devnet-id` is not wired into any automated harness.**
   `smoke-tier2/01-deploy.sh` still uses the older sed-rewrite-and-revert path
   (`:78-82`) rather than the new feature. So the feature ships unexercised by CI —
   the only validation is this manual rebuild. Acceptable for an opt-in redeploy tool;
   worth a follow-up to migrate smoke to `--features ...,devnet-id` and delete the
   fragile sed/trap. Not blocking.
2. **(LOW, robustness) A malformed `PACT_DEVNET_PROGRAM_ID` crashes module load.**
   `new PublicKey(trimmed)` throws inside the `NETWORK_CONFIGS` initializer
   (`network.ts:62`), so a typo'd devnet env var breaks importing the module *even for
   a mainnet consumer* of the same module. This is fail-loud and the var is
   devnet-namespaced + opt-in, so impact is minimal; could be softened to warn-and-null
   if desired. Not blocking.

**No blocking findings. Safe to merge.**
