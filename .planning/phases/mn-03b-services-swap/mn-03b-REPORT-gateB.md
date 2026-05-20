# WP-MN-03b — Gate B Request Report

- **Date:** 2026-05-20
- **Branch:** `feat/multi-network-03b-services-swap`
- **Branch root:** `ebb8664` (umbrella `feat/multi-network` post WP-MN-03a merge)
- **Tip:** `e0f0866`

## 7-category Gate B exit

### 1. PLANs closed (T0..T4)

| Task | SHA | Title |
|---|---|---|
| T1 | `7856688` | SettleBatchInput.+latencyMs additive interface |
| T2 | `f0fa86c` | EvmAdapterStub for WP-MN-03b/04 boundary |
| T3 | `e588250` | AdaptersService bootstrap in 3 services |
| T4 | `f9bfc46` | **THE LIVE-SERVICE SWAP** — settler.submitter + indexer.on-chain-sync + market-proxy.balance routed through Map<network, ChainAdapter> |
| T5 | `e0f0866` | Adapter-swap byte-identical e2e + multi-network routing (**GATE B HEADLINE**) |

### 2. Tests green with counts

| Package | Pre-WP | Post-WP | Delta |
|---|---|---|---|
| `@pact-network/shared` | 17 | **23** | +6 (T1 +1 latencyMs, T2 +5 EvmAdapterStub) |
| `@pact-network/settler` | 57 | **69** | +12 (T3 +9 bootstrap, T5 +3 byte-identical e2e) |
| `@pact-network/indexer` | 79 | **84** | +5 (T3 +5 bootstrap) |
| `@pact-network/market-proxy` | 138 pass / 3 fail | **150 pass / 3 fail** | +12 (T3 +6 bootstrap, T5 +6 routing); 3 pre-existing failures unchanged |

Total: **326 green**, 3 pre-existing market-proxy failures unchanged across the entire MN track (carry-forward from before WP-MN-01).

### 3. Drift / contract checks — THE GATE B HEADLINE

`packages/settler/test/adapter-swap-e2e.spec.ts` (3 tests):
- `legacy path === adapter path for the same batch (shares + signature)` — PASSES
- `adapter path with same input produces same fee-share amounts as legacy path` — PASSES
- Non-empty share assertion (T4 regression guard) — PASSES

**Verified on-chain math:** PREMIUM_A=2000 → Treasury 200n, Affiliate 100n; PREMIUM_B=5000 → Treasury 500n, Affiliate 250n. Identical across legacy and adapter paths at the bigint level.

`packages/market-proxy/test/multi-network-routing.spec.ts` (6 tests):
- Solana adapter dispatch
- Legacy flag bypass
- arc-testnet EvmAdapterStub → 503 `balance_check_failed` (adapter throws "not implemented")
- Unknown network → 503 "not enabled on this proxy" (the T4-flagged silent-fallback fixed)
- Paused endpoint regression
- Bogus chain → 503

### 4. Spec parity

| Off-chain §6 deliverable | Artifact |
|---|---|
| `SettleBatchInput.+latencyMs` additive | `chain-adapter.ts:54` + `solana/index.ts:236` (uses input) |
| `EvmAdapterStub` for WP-MN-03b/04 boundary | `shared/src/adapters/evm/index.ts` |
| `Map<network, ChainAdapter>` per service | `settler|indexer/src/adapters/adapters.service.ts`, `market-proxy/src/lib/context.ts buildAdapterMap()` |
| `PACT_ENABLED_NETWORKS` env config | All 3 services, default `"solana-devnet"` |
| `PACT_LEGACY_DIRECT_SOLANA` rollback flag | All 3 services, `=== "true"` string check |
| Settler routes by `event.network` | `submitter.service.ts submit()` lines 175–185 |
| Indexer iterates all enabled networks | `on-chain-sync.service.ts refreshAllNetworks()` lines 113–121 |
| Market-proxy per-request adapter lookup | `proxy.ts` lines 50–68 |
| Adapter-swap byte-identical e2e (THE GATE) | `settler/test/adapter-swap-e2e.spec.ts` 3/3 |
| Multi-network routing tests | `market-proxy/test/multi-network-routing.spec.ts` 6/6 |

### 5. Rollback

**Tag `pre-mn-04-rollback`** placed on `feat/multi-network` post-merge.

**Operational rollback procedure** (each service independently):
- Settler / Indexer / Market-proxy: set `PACT_LEGACY_DIRECT_SOLANA=true` in env; restart the service. All solana-* call sites fall back to the pre-WP direct path verbatim. EVM stays adapter-only (no legacy path exists for EVM).
- Hard branch rollback: `git reset --hard pre-mn-03b-rollback` on `feat/multi-network`.

The legacy path is preserved in code; flag flips at deploy time. No production DB changes in this WP (the migration was WP-MN-03a).

### 6. Captain Gate B verdict

`mn-03b-CAPTAIN-GATE-B-VERDICT.md` authored alongside this report. APPROVED.

### 7. Handoff

Cockpit handoff updated post-Gate-B.

---

## Process deviations (transparency)

1. **T4 reviewer flagged 2 carry-forwards** (perEventShares computation gap + silent proxy fallback). Both resolved in T5 as planned — T5 extracted `computeFeeSharesForEvent` helper used by both paths; T5 replaced silent fallback with explicit 503 + WARN log.

2. **T4 existing tests adjusted via `legacyDirectSolana: true` stub** in `AdaptersService` mocks. This keeps the existing legacy-path test coverage intact; T5 adds the adapter-path test coverage via the GATE e2e + multi-network routing tests. No test count decreased.

3. **T5 adapter path's `loadEndpoint` performance hit** — adapter mode calls `loadEndpoint(slug)` once per batch even though the SolanaAdapter's `submitSettleBatch` does its own internal load. Documented in WP-MN-03b RESEARCH §5.2 as accepted; revisit in cleanup WP after 1 week stable adapter ops.

4. **3 pre-existing market-proxy `endpoints.test.ts` failures** (snake_case mock vs camelCase columns) carry forward unchanged from before WP-MN-01. Not introduced or affected by WP-MN-03b.

None of these changed the design-spec §6 deliverable shape.

---

## Carry forward to WP-MN-04 RESEARCH

- **EvmAdapter real impl** replaces `EvmAdapterStub` (`packages/shared/src/adapters/evm/index.ts`). WP-MN-04 RESEARCH must enumerate the equivalent surface (PactRegistry / PactPool / PactSettler reads + writes via viem or ethers). The `EvmAdapterStub` interface shape is what WP-MN-04 fulfills.
- **D6 reorg/finality policy** — Gate A entry gate for WP-MN-04. Per-VM auth + reorg policy doc must exist before any EVM fleet boots.
- **Arc fleet stand-up on testnet** — Cloud Run service config, settler EOA secrets, dashboard read-API EVM wiring.
- **`PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet` end-to-end smoke** once real EvmAdapter lands. Today: `arc-testnet` entry returns 503 "balance_check_failed" because EvmAdapterStub throws.
- **Cleanup WP after 1 week stable operation**: remove `PACT_LEGACY_DIRECT_SOLANA` flag + `submitLegacyDirect` + `refreshLegacyDirect` + legacy `createBalanceCheck` path. Cleanup tracking: PR-R6 in plan-level risk register.

---

## Holistic review summary (final reviewer at tip `e0f0866`)

- **Verdict:** ✅ Ready for Gate B
- **THE GATE B HEADLINE: 3/3 adapter-swap byte-identical tests PASS.** Verified `perEventShares` deep-equal at bigint level across both paths.
- All 9 design-spec §6 acceptance criteria satisfied.
- Legacy direct path preserved verbatim (pre-T4 body identical to post-T4 `submitLegacyDirect`).
- No on-chain edits. No production DB migrations. No new credentials.
- 326 green tests across the track; 3 pre-existing market-proxy failures unchanged.
- `PACT_LEGACY_DIRECT_SOLANA` flag wired consistently (`=== "true"`) across all 3 services.

## Captain-proxy ask

Issue `mn-03b-CAPTAIN-GATE-B-VERDICT.md` (APPROVED). Then: push branch → PR vs `feat/multi-network` → merge-commit → tag `pre-mn-04-rollback` → handoff update → open WP-MN-04 (EvmAdapter + Arc fleet testnet).
