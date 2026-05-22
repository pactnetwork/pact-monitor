# Deployment Topology — Concurrent Multi-EVM (note for Rick / gcloud owner)

Written 2026-05-22 after the concurrent-multi-EVM enablement WP (branch feat/concurrent-multi-evm). Tu owns on-chain + code; Rick owns all gcloud (Cloud Run, Secret Manager, Pub/Sub). This note is the deploy-side guidance.

## Core principle

One Docker image per service (proxy, indexer, settler). Which networks an instance serves is purely env: PACT_ENABLED_NETWORKS (comma-separated, e.g. "solana-devnet,arc-testnet,base-mainnet"). You never fork the scaffold per chain — you choose the Cloud Run topology at deploy time and can change it later without code.

## Recommended topology: consolidated by default, split the hot chain by exception

Start consolidated (cheapest — fewest always-on instances):
- 1 proxy service — all chains. Stateless request routing; no reason to split.
- 1 indexer service — all chains. Settlement ingest is push-based (settler -> POST /events) and fully network-keyed; the only background work is a 5-min config-sync cron (now cursor-resumed + parallelized per network).
- 1 settler service — all chains. Batches partition by (network, slug) and now flush in parallel with per-group failure isolation, so one chain's slow finality no longer blocks the others.

Split by exception — give a chain its own settler when it needs an independent failure domain, gas funding/alerting, or throughput SLA:
- Run the SAME image with PACT_ENABLED_NETWORKS=<that-chain-only>. An EVM-only settler now boots clean (no Solana env required) — verified: node dist/main.js with no SOLANA_RPC_URL / SETTLEMENT_AUTHORITY_KEY starts and /health returns 200.

Cost framing: settler/indexer want min-instances=1 (queue consumer / cron), so each dedicated service is ~one always-on instance. Consolidate to minimize always-on instances; peel off only the chain that earns it.

## Per-chain env (set per Cloud Run service)

- PACT_ENABLED_NETWORKS — which networks this instance serves.
- Deployment addresses (per EVM chain): PACT_EVM_REGISTRY_<NETWORK>, PACT_EVM_POOL_<NETWORK>, PACT_EVM_SETTLER_<NETWORK> where <NETWORK> = uppercased, dashes->underscores (e.g. ARC_TESTNET, BASE_MAINNET). Precedence: per-chain key -> legacy global PACT_EVM_REGISTRY -> baked DEPLOYMENTS. For 2+ EVM chains in one instance you MUST use per-chain keys (or bake into DEPLOYMENTS) — the old global keys cannot disambiguate two chains.
- Signer (per network): PACT_SETTLER_KEYPAIR_<NETWORK>. Phase 1 = raw 0x-hex (EVM) / base58 JSON (Solana). Phase 2 (Secret Manager resource path) is NOT yet wired — set raw values for now.
- RPC (per network): PACT_RPC_URL_<NETWORK> (else falls back to chains.json rpcUrl for EVM / SOLANA_RPC_URL for Solana).
- EVM gas-balance alert thresholds (per network, optional): PACT_EVM_GAS_WARN_WEI_<NETWORK> / PACT_EVM_GAS_CRIT_WEI_<NETWORK>. Defaults 0.01 / 0.003 native token. Warn/alert only — a low EVM balance does NOT flip /health to 503 (one underfunded chain must not deroute a multi-chain settler).
- Solana env (SOLANA_RPC_URL, SETTLEMENT_AUTHORITY_KEY) — required ONLY when a solana-* network is in PACT_ENABLED_NETWORKS. Omit them for an EVM-only settler.

## Health

- Mixed / Solana-enabled settler: /health gates on Solana signer balance as before.
- EVM-only settler: /health returns 200 with reason "EVM-only deploy — Solana signer not monitored" (EVM gas is alert-only). Safe for the Cloud Run health check.

## To onboard a new EVM chain (e.g. Base) — separate downstream work

Code now SUPPORTS it; onboarding still requires (out of scope for this WP):
1. Deploy the 3 Solidity contracts (PactRegistry, PactPool, PactSettler) + confirm USDC address on the chain.
2. Add the chain to packages/program-evm/protocol-evm-v1/config/chains.json (chainId, usdcAddress, rpcUrl, blockTimeMs, finalityBlocks, deploymentBlock).
3. Add chainId -> addresses to DEPLOYMENTS in protocol-evm-v1-client/src/addresses.ts (or supply via the per-chain env keys above).
4. Fund a settler signer on the chain and grantRole(SETTLER_ROLE, <signer>) on that chain's PactPool AND PactRegistry (on-chain; Tu).
5. Register endpoints (currently only via cast send PactRegistry.registerEndpoint — EVM endpoint-registration tooling is a separate WP).
6. Add the chain to PACT_ENABLED_NETWORKS on the chosen service(s) and apply the indexer SyncCursor migration to the indexer DB (ops-owned DB; never prod-direct from a dev box).

## DB migration owed

This WP adds a SyncCursor table (packages/db/prisma/migrations/20260522000000_add_sync_cursor). Apply with prisma migrate deploy against the ops-owned indexer Postgres (validated locally; additive, no data-loss op).
