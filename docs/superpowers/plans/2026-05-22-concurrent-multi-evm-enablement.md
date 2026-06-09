# Concurrent Multi-EVM-Chain Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every task and superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Hard gate:** Task 0 writes a FAILING concurrency acceptance test that bootstraps TWO EVM chains in one fleet and proves they settle isolated and in parallel. It must be RED for the right reasons before any fix task, and GREEN before the WP is done. Substitute only the viem transport (`fetch`) and Postgres — never mock the batcher flush loop, the adapter dispatch, `submitSettleBatch`, or `encodeSettleBatch`.

**Goal:** Make a single running Pact fleet (one settler + one indexer + one proxy) genuinely serve MULTIPLE EVM chains at the same time — isolated failure domains, parallel settlement, no shared-state collisions — and prove it with a synthetic two-EVM-chain concurrency test. No new real chain is deployed in this WP.

**Architecture:** Today the fleet is config-driven (loops `PACT_ENABLED_NETWORKS`) and already handles Solana + ONE EVM chain. Three localized constraints block a *second* concurrent EVM chain: (1) the deployment-address env overlay is global, not chain-scoped; (2) the settler flush loop submits batches serially, so one slow chain head-of-line-blocks others; (3) the indexer config-sync re-walks from `deploymentBlock` every tick with no cursor, so cost scales with chain height. This WP fixes those plus two readiness gaps (EVM signer balance monitoring; settler must boot without Solana), proven by the Task 0 gate.

**Tech Stack:** TypeScript, NestJS (settler + indexer), Hono (market-proxy), viem (`@pact-network/protocol-evm-v1-client`), Prisma (`@pact-network/db`), Vitest, local docker Postgres (NEVER production DB), pnpm + turbo.

---

## Constraints (carry into every task)

- **pnpm, not npm. No emojis. No blockquotes in copy-paste content. No production-DB writes** (local docker Postgres only; migrations applied to local DB).
- **No remote pushes / no merges without Tu's explicit go.** Local commits per task expected.
- **Anchor crate FROZEN.** **Solana source-of-truth** for any fee/accounting parity.
- **Do NOT regress the existing single-EVM-chain (Arc) + Solana behavior**, the PR #226 fixes, or the PR #224 hotfixes. Run the existing Arc e2e (`arc-testnet-settle-e2e.spec.ts`) after each task — it must stay 8/8.
- **Goal-backward rule:** any mid-task scope cut triggers a reachability re-check against the Task 0 concurrency gate, not just a task re-plan. STOP-AND-ASK if unsure.
- Branch: a fresh `feat/concurrent-multi-evm` off the current integration branch (confirm base with captain at execution time).

## The acceptance bar (what "concurrent multi-EVM" means)

One settler instance, bootstrapped with two EVM chains enabled, each with its OWN deployment addresses, where a flush containing both chains' batches: (a) resolves distinct per-chain registry/pool/settler addresses (no env collision); (b) submits both chains in parallel; (c) isolates failure — one chain's stalled/hung finality wait does NOT block the other chain's settlement; (d) encodes each chain's calldata correctly. Plus: the settler can boot EVM-only (no Solana), and the indexer config-sync resumes from a per-network cursor.

## File Structure (what each task touches)

| Task | Files | Responsibility |
|---|---|---|
| 0 acceptance gate | NEW `packages/settler/test/multi-evm-concurrency.spec.ts`; test-only synthetic chain fixture | Two EVM chains in one settler; RED first |
| 1 chain-scoped deploy keys | `packages/protocol-evm-v1-client/src/addresses.ts` (ENV_KEYS 62-66, resolveDeployment 81-95); call sites `settler/src/adapters/adapters.service.ts:69`, `indexer/src/adapters/adapters.service.ts:59`, `market-proxy/src/lib/context.ts:55` | Per-chain `PACT_EVM_*_<CHAIN>` resolution |
| 2 parallel settler flush | `packages/settler/src/batcher/batcher.service.ts:96-102` | Concurrent per-(network,slug) flush + failure isolation |
| 3 indexer sync cursor | `packages/db/prisma/schema.prisma` (new model); `packages/indexer/src/sync/on-chain-sync.service.ts:112-121,210-235` | Resume config-sync from last block; parallelize network loop |
| 4 EVM balance monitoring | `packages/settler/src/.../signer-balance.service.ts:96-99` | Per-network EVM signer gas-balance checks |
| 5 settler EVM-only boot | `packages/settler/src/submitter/submitter.service.ts:142-153` | Solana deps conditional on a Solana network being enabled |
| 6 fix legacy hardcode | `packages/indexer/src/sync/on-chain-sync.service.ts:300` | Stamp legacy-direct rows with the real Solana network, not literal |

---

## Task 0: Two-EVM-chain concurrency acceptance gate (THE GATE)

**Files:** Create `packages/settler/test/multi-evm-concurrency.spec.ts`. Add a test-only synthetic EVM chain (distinct chainId, e.g. `evm-test-2` / chainId 999999) WITHOUT polluting the production `chains.json` / `DEPLOYMENTS` — prefer constructing `ChainDescriptor`s / injecting a test chains map, or a test-scoped fixture. Mirror the real-seam style of `arc-testnet-settle-e2e.spec.ts`.

- [ ] **Step 1: Read the seams.** Read `adapters.service.ts` (bootstrap loop), `batcher.service.ts` (flush), `submitter.service.ts` (submit), `shared/src/adapters/evm/index.ts` (submitSettleBatch + finality wait 445-483), `addresses.ts` (resolveDeployment). Identify how to wire the REAL `AdaptersService` + REAL `BatcherService`/`PipelineService` + two REAL `EvmAdapter`s, substituting ONLY each chain's viem transport (`fetch`) and Postgres.

- [ ] **Step 2: Write the failing concurrency test.** Bootstrap one settler with `PACT_ENABLED_NETWORKS="arc-testnet,evm-test-2"`, each chain given its OWN registry/pool/settler addresses. Assert, end-to-end:
  1. **Distinct deployments:** the two `EvmAdapter`s resolve DIFFERENT registry/pool/settler addresses (proves chain-scoped keys; fails today because the env overlay is global -> both get the same override).
  2. **Both settle:** a flush containing a batch for each chain invokes `submitSettleBatch` on BOTH adapters, each encoding its own chain's calldata with a `0x` bytes16 callId from a real UUID.
  3. **Parallel + isolated:** make chain A's transport delay its finality (e.g. a slow/hanging `fetch` for A's confirmation poll); assert chain B's settlement still completes within a bound that proves it did NOT wait serially behind A (fails today: serial `for await` at `batcher.service.ts:96-102`).
  4. **No nonce/state cross-talk:** each chain uses its own signer; assert no shared mutable state leaks between the two adapters.

- [ ] **Step 3: Run, confirm RED for the right reasons.** Run: `pnpm --filter @pact-network/settler exec vitest run multi-evm-concurrency`. Expected FAIL at: identical deployment addresses (finding 1 / env scope) and serial blocking (finding 2). Capture output. If it fails on harness wiring, fix the harness (never by mocking the flush/adapter seam) until it fails for these reasons.

- [ ] **Step 4: Commit the RED test.**
```bash
git add packages/settler/test/multi-evm-concurrency.spec.ts
git commit -m "test(settler): add failing two-EVM-chain concurrency acceptance gate (multi-evm WP T0)"
```

**Captain review gate:** verify (grep) the test mocks neither `submitSettleBatch`/`encodeSettleBatch` nor the flush loop, and that the RED failures are the env-collision + serial-blocking ones — not a harness artifact.

---

## Task 1: Chain-scoped deployment env keys (env-collision finding)

Blocked by Task 0. Turns Task 0 assertion #1 green.

**Files:** `protocol-evm-v1-client/src/addresses.ts`; call sites in the three services.

- [ ] **Step 1: Failing unit test.** In `protocol-evm-v1-client`, assert `resolveDeployment(chainA, env)` and `resolveDeployment(chainB, env)` return DIFFERENT addresses when env provides per-chain keys (`PACT_EVM_REGISTRY_<CHAINA>` vs `PACT_EVM_REGISTRY_<CHAINB>`), and that a chain with no per-chain key falls back to its `DEPLOYMENTS` baked value. Also assert backward-compat: a legacy global `PACT_EVM_REGISTRY` still applies when no per-chain key is set (so the single-chain Arc deploy keeps working).
- [ ] **Step 2: Implement chain-scoped keys.** Extend `ENV_KEYS` / `resolveDeployment` (`addresses.ts:62-95`) to look up `PACT_EVM_REGISTRY_<CHAINID-or-NAME>` first, then fall back to the global `PACT_EVM_REGISTRY`, then to the baked `DEPLOYMENTS` value. Choose the suffix scheme (chainId vs network name) to match how the other services build env keys (`adapters.service.ts` uses `network.replace(/-/g,"_").toUpperCase()` — mirror that for consistency). Document precedence in the function comment.
- [ ] **Step 3: Update call sites** if the signature changes (`settler/src/adapters/adapters.service.ts:69`, `indexer/src/adapters/adapters.service.ts:59`, `market-proxy/src/lib/context.ts:55`) so each passes its network identity for per-chain resolution.
- [ ] **Step 4: Run + commit.** Run the new unit test + Task 0 (assertion #1 now green) + the Arc e2e (still 8/8). Commit.

**Captain review gate:** confirm single-chain Arc still resolves correctly via both the baked value and the legacy global key (no regression for the live deploy).

---

## Task 2: Parallel settler flush with failure isolation (head-of-line-blocking finding)

Blocked by Task 1. Turns Task 0 assertions #2 and #3 green.

**Files:** `packages/settler/src/batcher/batcher.service.ts:96-102`.

- [ ] **Step 1: Failing test.** Assert that two per-`(network,slug)` groups in one flush run concurrently and are failure-isolated: if group A's `onFlush` rejects/hangs, group B still completes (and A's failure is surfaced, not swallowed). (This is Task 0 assertion #3 isolated.)
- [ ] **Step 2: Parallelize the flush loop.** Replace the serial `for ... await this.onFlush(...)` (`batcher.service.ts:96-102`) with concurrent dispatch over the partitioned groups using `Promise.allSettled`, preserving: per-group error handling (a rejected group must nack/redeliver its own batch without affecting siblings), and the existing single-network-per-group guarantee. Keep ordering within a group. Ensure no unbounded concurrency issue (groups are bounded by distinct (network,slug) pairs per flush; acceptable — but note any need for a concurrency cap).
- [ ] **Step 3: Run + commit.** Run the new test + Task 0 (#2, #3 green) + full settler suite (Solana guards + Arc e2e 8/8, no regression). Commit.

**Captain review gate:** confirm a failing group still nacks correctly (check `pipeline.service.ts` nack path) and does not take down sibling groups; confirm Solana batch path unaffected.

---

## Task 3: Indexer per-network sync cursor + parallel config-sync (height-scaling finding)

Independent of Tasks 1-2 (separate package) but verify against the same fleet model.

**Files:** `packages/db/prisma/schema.prisma` (new model); `packages/indexer/src/sync/on-chain-sync.service.ts:112-121,210-235`.

- [ ] **Step 1: Failing test.** Assert that after one config-sync pass for a network, the next pass RESUMES from the persisted last-scanned finalized block instead of re-walking from `deploymentBlock` (assert the second pass's `getContractEvents`/`eth_getLogs` `fromBlock` is the stored cursor, not `deploymentBlock`). Use a fake transport recording the requested block ranges.
- [ ] **Step 2: Add the cursor model.** Add a `SyncCursor` Prisma model keyed by `network` (`network` PK, `lastScannedBlock BigInt`, `updatedAt`). Generate a migration; apply to LOCAL docker Postgres only. (Do not run against any remote/prod DB.)
- [ ] **Step 3: Use the cursor in `readEndpointConfigs` sync.** In `on-chain-sync.service.ts` (the path around 210-235 driving the chunked scan), read the cursor as `fromBlock`, advance/persist it after each successful pass. Preserve the PR #224 9.5k-block chunking. Cold start (no cursor) still begins at `deploymentBlock`.
- [ ] **Step 4: Parallelize the network loop.** Change `refreshAllNetworks` (`:112-121`) from sequential `for ... await` to concurrent per-network (`Promise.allSettled`), keeping the per-network try/catch isolation so one chain's failure doesn't abort others.
- [ ] **Step 5: Run + commit.** Run the cursor test + indexer suite (events.service finding-5 tests stay green; Solana ingest under solana-devnet). Commit.

**Captain review gate:** confirm cold-start still walks from `deploymentBlock`; confirm cursor is per-network (no cross-network overwrite); confirm Solana legacy path unaffected.

---

## Task 4: EVM signer gas-balance monitoring

Independent. Readiness, not correctness — but required before running a 2nd EVM chain unmonitored.

**Files:** `packages/settler/src/.../signer-balance.service.ts:96-99` (the Solana-only cron).

- [ ] **Step 1: Failing test.** Assert the balance service checks the gas-token balance of each ENABLED EVM signer (per network) and warns/alerts below a threshold, in addition to the existing Solana check.
- [ ] **Step 2: Extend the service.** Add per-network EVM balance checks (viem `getBalance` on each EVM adapter's signer account) alongside the existing Solana check; keep the Solana check unchanged. Reuse `AdaptersService.listEnabledNetworks()` + `getEvmAccount(network)`.
- [ ] **Step 3: Run + commit.** Run the new test + settler suite. Commit.

---

## Task 5: Settler boots without Solana

Independent. Needed so an EVM-only dedicated settler (the hybrid escape hatch) can boot.

**Files:** `packages/settler/src/submitter/submitter.service.ts:142-153`.

- [ ] **Step 1: Failing test.** Assert that with `PACT_ENABLED_NETWORKS` containing NO `solana-*` network, the settler bootstraps without requiring `SOLANA_RPC_URL` (today the constructor `getOrThrow`s it + builds a Solana `Connection` + PDAs unconditionally).
- [ ] **Step 2: Make Solana deps conditional.** Gate the Solana `Connection`/PDA construction (`:142-153`) on a Solana network being enabled (e.g. lazily, or guard on `enabled.some(n => n.startsWith("solana"))`). EVM-only deployments boot clean; Solana-enabled deployments behave exactly as today.
- [ ] **Step 3: Run + commit.** Run the new test + full settler suite (Solana path unchanged when Solana enabled; Arc e2e 8/8). Commit.

---

## Task 6: Fix legacy-direct hardcoded network

Independent, small correctness fix.

**Files:** `packages/indexer/src/sync/on-chain-sync.service.ts:300`.

- [ ] **Step 1: Failing test.** Assert the legacy-direct Solana config-sync path stamps rows with the actual Solana network (e.g. derived from the enabled Solana network / descriptor), not the literal `"solana-devnet"` — so a Solana-mainnet legacy deploy labels rows `solana-mainnet`.
- [ ] **Step 2: Fix.** Replace `const syncNetwork = "solana-devnet"` (`:300`) with the resolved Solana network for the legacy-direct path.
- [ ] **Step 3: Run + commit.** Run the test + indexer suite. Commit.

---

## Final gate

- [ ] Task 0 concurrency gate fully GREEN (all 4 assertions).
- [ ] Existing Arc e2e `arc-testnet-settle-e2e.spec.ts` still 8/8 (no regression).
- [ ] `pnpm -r build` clean; relevant suites green: settler, indexer, shared, market-proxy, protocol-evm-v1-client, protocol-v1-client (Solana).
- [ ] Empirically boot `node dist/index.js` for the proxy AND confirm an EVM-only settler boot (Task 5) starts without Solana.
- [ ] Captain writes a short DEPLOYMENT-TOPOLOGY note for Rick (gcloud owner): consolidated-default (1 proxy + 1 indexer + 1 settler, all chains via `PACT_ENABLED_NETWORKS`) and the split-the-hot-chain escape hatch (dedicated settler per hot chain = same image, single-network env). This is documentation, not a code task.
- [ ] Captain assembles the PR. **No push without Tu's explicit go.**

---

## Out of scope (track separately)

- **Base (or any specific chain) onboarding** — deploy the 3 contracts, add to `chains.json` + `DEPLOYMENTS`, grant `SETTLER_ROLE`, register endpoints. This WP only proves the *capability* with a synthetic chain. Base onboarding is a downstream plan that consumes this.
- **EVM endpoint-registration tooling** (CLI/dashboard/curated providers are Solana-only; EVM endpoints via `cast send`). Separate WP.
- **EVM ops-tx support** (`indexer/src/ops/ops.service.ts:7` hardcodes a Solana program ID; ops tx-building is Solana-only). Separate.
- **Solana program-id drift** (memory `project-solana-program-id-drift`) — fix before the cleanup WP flips `PACT_LEGACY_DIRECT_SOLANA=false`.
- **Cloud Run deployment** itself — Rick owns gcloud; this WP delivers the topology note, not the deploy.
- **StatsService single-slot cache** -> keyed map (perf only, `indexer/src/stats/stats.service.ts:40-55`) — nice-to-have, not a blocker.

## Self-review notes

- Coverage: env-scope (T1), parallel flush (T2), sync cursor (T3) are the three core gap-closers; T4/T5/T6 are readiness + a latent-bug fix; T0 is the goal-backward acceptance gate. The deployment topology (the "hybrid" decision) is delivered as a note for Rick since gcloud is his domain.
- Type/name consistency: the per-chain env-key suffix scheme chosen in T1 (`network.replace(/-/g,"_").toUpperCase()`) must match what T0's test uses to set the two chains' addresses.
- The plan deliberately leaves implementation code to crew TDD against the real files; the non-negotiables (synthetic-chain real-seam test first, no mocking the flush/adapter seam, RED-before-fix, Arc e2e stays 8/8) are pinned because they are what makes "concurrent" provable rather than asserted.
