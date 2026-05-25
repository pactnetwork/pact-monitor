# WP-MN-03b — Services swap to SolanaAdapter (multi-network per service) — CONTEXT

- **Track:** Multi-Network refactor (MN), fourth WP — the **RISKIEST**
- **Branch:** `feat/multi-network-03b-services-swap` (off `feat/multi-network@ebb8664` after WP-MN-03a merge)
- **Captain:** Tu (out-of-office); captain-proxy continues per directive
- **Date opened:** 2026-05-20

## Purpose

Swap the three chain-touching service modules from direct `@q3labs/pact-protocol-v1-client` + `@pact-network/wrap` usage to the `SolanaAdapter` interface (from `@pact-network/shared`, WP-MN-02). At the same time, restructure each service to hold a **`Map<network, ChainAdapter>` instead of a single adapter**, per the locked **multi-network-per-service topology** (decided 2026-05-20, supersedes off-chain spec §7's original fleet-per-network framing).

This is the only WP that touches live Solana settlement code. The Gate B headline artifact is the **adapter-swap e2e diff**: with `network='solana-devnet'`, running the pipeline on the legacy direct path (via the new `PACT_LEGACY_DIRECT_SOLANA=true` env flag) must produce **byte-identical** Settlement transactions, indexer rows, and fee fan-out as running on the adapter path. Any non-empty diff is a Gate B BLOCKER.

## Topology supersession note

**Off-chain spec §7 (`docs/evm/2026-05-19-multi-network-offchain-services-spec.md`)** describes a fleet-per-network deployment: separate Cloud Run instances for each network's market-proxy and settler. This WP supersedes that framing — Tu's 2026-05-20 decision: **one market-proxy + one settler + one indexer**, each holding a `Map<network, ChainAdapter>`, routing internally by `event.network` (settler), `endpoint.network` (proxy), and iterating all adapters per refresh (indexer cron).

Spec doc update is folded into a future doc-cleanup commit on `docs/multi-network-design` (PR #216 may still be open or already merged at that point). For WP-MN-03b execution purposes, this CONTEXT is the authoritative topology spec.

## Upstream artifacts (READ FIRST)

- `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §6 — WP-MN-03b deliverables, Gate A entry, 7-cat Gate B exit. PR-R2 in plan-level risk register (adapter not byte-identical under production load).
- `docs/evm/2026-05-19-multi-network-offchain-services-spec.md` §2.5 (per-VM auth) + §2.6 (reorg + idempotency).
- `.planning/phases/mn-02-chain-adapter/mn-02-REPORT-gateB.md` §"Carry forward to WP-MN-03b RESEARCH":
  - `EndpointConfigSnapshot` projection drift (Solana lacks `authority`/`maxTotalFeeBps` — consumers dip into `raw`).
  - `SettleBatchInput.events` lacks `latencyMs` — adapter currently hardcodes 0.
- `.planning/phases/mn-03a-network-wire/mn-03a-REPORT-gateB.md` §"Carry forward to WP-MN-03b RESEARCH":
  - Unify the `"solana-devnet"` hardcoding at `proxy.ts:137` + `on-chain-sync.service.ts:210`.

## In scope

### Service refactors (3 modules)

1. **`packages/settler/src/submitter/submitter.service.ts`** —
   - Holds `Map<network, ChainAdapter>` built at boot from `PACT_ENABLED_NETWORKS` (comma-separated list, default `"solana-devnet"`).
   - Per-network signer key loaded from Secret Manager keyed by `pact-settler-<network>`.
   - Each batch submit routes by the first event's `network` to the right adapter; calls `adapter.submitSettleBatch(...)` instead of direct `buildSettleBatchIx` + `sendAndConfirmTransaction`.
   - `PACT_LEGACY_DIRECT_SOLANA=true` env flag falls back to the pre-WP direct path for `solana-*` networks (rollback safety).

2. **`packages/indexer/src/sync/on-chain-sync.service.ts`** —
   - Holds `Map<network, ChainAdapter>` built at boot the same way.
   - Cron iterates every enabled network, calls `adapter.readEndpointConfigs()` per network, upserts Endpoints with each one's actual `network` (no hardcoded `"solana-devnet"` literal).
   - Removes the `syncNetwork = "solana-devnet"` placeholder added in WP-MN-03a T4.
   - `PACT_LEGACY_DIRECT_SOLANA=true` falls back to the pre-WP `connection.getProgramAccounts` path for `solana-*`.

3. **`packages/market-proxy/src/routes/proxy.ts` + `packages/market-proxy/src/lib/balance.ts`** —
   - Holds `Map<network, ChainAdapter>` at boot.
   - Per-request: read the endpoint's `network` from the in-memory endpoint cache (already populated from DB post-WP-MN-03a), look up the adapter, call `adapter.checkAgentEligibility(walletPubkey, requiredPremium)` for the eligibility check.
   - Removes the `getChain("solana-devnet").network` literal at `proxy.ts:137`; the network value comes from the resolved endpoint.
   - `PACT_LEGACY_DIRECT_SOLANA=true` falls back to the pre-WP `createBalanceCheck` path for `solana-*`.

### Env / config / secrets

- `PACT_ENABLED_NETWORKS` — comma-separated list of network names from the registry. Default `"solana-devnet"`. Services validate each name via `getChain(name)` at boot; throw on unknown.
- `PACT_LEGACY_DIRECT_SOLANA` — boolean (default `false`). When `true`, all `solana-*` adapter call sites fall back to the legacy direct path. Each service prints the active path at startup so the operator can see which mode is live.
- Per-network signing key (settler only): `pact-settler-<network>` in Secret Manager. For `solana-devnet`, this is the existing Solana keypair env. For future EVM networks, this will be an EVM private key (WP-MN-04 provisions).

### Tests

- **Adapter-swap byte-identical e2e** (`packages/settler/test/adapter-swap-e2e.spec.ts` — Settler-driven against local docker postgres). For `network='solana-devnet'`:
  - Run the same SettlementEvent through the pipeline twice: once with `PACT_LEGACY_DIRECT_SOLANA=true`, once with `false`.
  - Capture: the on-chain Settlement signature (mocked via stub Connection), the indexer DB state after ingest, the per-recipient share breakdown.
  - Diff: must be **empty**. Gate B blocks on any divergence.
- **Multi-network startup**: services boot with `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet` and instantiate two adapters in the Map. The Arc adapter is a `SolanaAdapter` stub (until WP-MN-04 lands `EvmAdapter`) OR an error-stub.
- **Routing**: an event with `network='arc-testnet'` is routed to the Arc adapter (which today returns "not implemented" until WP-MN-04).

## Out of scope

- **`EvmAdapter` implementation** — WP-MN-04 ships it. WP-MN-03b ships a stub that throws "not implemented" so the routing path is exercisable but EVM settlement doesn't actually fire.
- **Arc fleet stand-up on testnet** — WP-MN-04.
- **Removing the legacy direct path** — `PACT_LEGACY_DIRECT_SOLANA=true` keeps it alive forever (or until a cleanup WP removes it after 1 week of stable adapter ops per plan-level PR-R6).
- **Per-VM auth specifics for EVM** (gas estimation, finality blocks) — WP-MN-04 RESEARCH.
- **Reorg policy doc (D6)** — gate-A entry for WP-MN-04, not WP-MN-03b.
- **Legacy Anchor crate edits** — frozen.
- **Production deploy** — WP-MN-03b runs against local docker postgres only.

## Non-negotiables

1. **Adapter-swap e2e diff is EMPTY for solana-devnet.** Non-empty = Gate B BLOCK.
2. **`PACT_LEGACY_DIRECT_SOLANA=true` works after the swap.** Every service must boot cleanly with the flag on AND with it off; both modes pass the existing test suite.
3. **No edits to `SolanaAdapter` itself.** WP-MN-02 locked it. If the adapter is missing a method WP-MN-03b needs, surface as BLOCKED — RESEARCH must amend before execution.
4. **No edits to the legacy Anchor crate.**
5. **No remote pushes during execution.**
6. **Live Solana traffic must NOT regress.** The same wallet that worked pre-WP-MN-03b works post-WP-MN-03b (existing test suite is the proof; live testnet validation happens at WP-MN-04 Gate B for Arc, separately).

## Gate-A entry criteria

Satisfied by this CONTEXT + the companion `mn-03b-RESEARCH.md`:
- Service refactor scope per file:line audited.
- Multi-network-per-service architecture decisions documented (env config, Map shape, routing rules, signer-per-network model).
- Two carry-forwards from WP-MN-02 and two from WP-MN-03a addressed in RESEARCH.
- Adapter-swap e2e diff strategy specified.
- Captain VERDICT APPROVED — pending.

## Captain expectations of Gate-A verdict

Captain (or proxy) reads `mn-03b-RESEARCH.md` and confirms:
- Every direct chain-touch site in the three service modules is enumerated.
- The Map<network, ChainAdapter> construction is well-specified (env parsing, signer loading, error handling for unknown networks).
- The `PACT_LEGACY_DIRECT_SOLANA` flag wiring is documented per service.
- The byte-identical e2e diff harness is feasible offline (fixture-based, no live RPC).
- The `EndpointConfigSnapshot` projection-drift carry-forward is resolved (either by extending the projection, or by accepting that consumers dip into `raw`).
- The `proxy.ts:137` + `on-chain-sync.service.ts:210` solana-devnet hardcoding is unified.
