# Pact Network — Endpoints & Chains Catalog (for registration)

Compiled 2026-05-29. Two things you register to onboard an insured endpoint:
1. **On-chain** — `register_endpoint` (Solana) / `registerEndpoint` (EVM) creates the EndpointConfig + coverage pool, premium, fee recipients.
2. **Off-chain** — a DB `Endpoint` row (`network`, `slug`, `upstreamBase`, premium mirror) so the proxy resolves `/v1/<slug>/…` to the upstream. The proxy's `handlerRegistry` (source) must have a handler for the slug.

Source of truth for canonical upstreams: `packages/indexer/src/sync/on-chain-sync.service.ts` → `DEFAULT_UPSTREAM_BASE`.
Handlers: `packages/market-proxy/src/endpoints/*.ts`.

---

## A. Curated provider endpoints (the upstreams)

| slug | canonical upstreamBase | handler | auth model | keyless? | in DEFAULT_UPSTREAM_BASE? |
|------|------------------------|---------|------------|----------|---------------------------|
| `helius` | `https://mainnet.helius-rpc.com` (devnet: `https://devnet.helius-rpc.com`) | helius.ts | `?api-key=` baked into upstreamBase (env `PACT_HELIUS_API_KEY`), no caller header | NO | yes |
| `birdeye` | `https://public-api.birdeye.so` | birdeye.ts | `X-API-KEY` header (caller passthrough) | NO | yes |
| `jupiter` | `https://api.jup.ag` — **live keyless tier verified: `https://lite-api.jup.ag` (use `/price/v3`)** | jupiter.ts | none (unauthenticated) | **YES** | yes |
| `elfa` | `https://api.elfa.ai` | elfa.ts | `Authorization: Bearer <key>`, operator-injected | NO | yes |
| `fal` | `https://queue.fal.run` | fal.ts | `Authorization: Key <key>`, operator-injected | NO | yes |
| `dummy` | `https://dummy.pactnetwork.io` (demo `pact-dummy-upstream`) | dummy.ts | none (unauthenticated); generic passthrough, strips `/v1/<slug>` prefix | **YES** | yes |
| `pay-default` | `https://facilitator.pact.network/pay-default` | (x402 facilitator) | x402 | n/a | yes |
| `moralis` | (not in default map) likely `https://deep-index.moralis.io` — CONFIRM | moralis.ts | `X-API-KEY` header | NO | **no — operator to set** |
| `covalent` | (not in default map) likely `https://api.covalenthq.com` — CONFIRM | covalent.ts | `Authorization` header | NO | **no — operator to set** |

Notes:
- **Keyless = usable for live smoke / demo without a provider secret:** `jupiter` (`lite-api.jup.ag/price/v3`) and `dummy`. These are what the 2026-05-29 multi-chain settle proof used.
- `jupiter` handler forwards `url.pathname` verbatim (good for `/price/*` once the slug prefix is the gateway's; for a plain REST GET through `/v1/<slug>/…` the `dummy` handler is the prefix-stripping generic passthrough). `/price/v2` is retired → use `/price/v3`.
- `moralis` / `covalent` have handlers but no committed default upstream — set `upstreamBase` explicitly when registering and confirm the base URL against the provider's current API docs before relying on it.
- Premiums on all production endpoints are flat (`percentBps = 0`); `dummy`/`helius` reference value `flatPremiumLamports = 1000` ($0.001/call), well above `MIN_PREMIUM_LAMPORTS = 100`.

---

## B. Per-chain config (where to register)

### Solana
| network | program ID | USDC mint | RPC |
|---------|-----------|-----------|-----|
| solana-devnet | `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` | devnet USDC | `https://api.devnet.solana.com` |
| solana-mainnet | `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | mainnet-beta |
- Devnet settle authority = `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS`. Mainnet upgrade authority = `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL`.
- **FS9 (devnet only):** deployed `5jBQ` predates the `protocol_config` kill-switch; client sends 5 fixed accounts, deployed expects 4. Pre-mainnet redeploy item. Mainnet `5bCJ` is fine (5-account).

### EVM (Arc 3-contract suite; SAME addresses across chains)
| contract | address (both arc-testnet + base-sepolia) |
|----------|-------------------------------------------|
| PactRegistry | `0x056bac33546b5b51b8cf6f332379651f715b889c` |
| PactPool | `0xa6135d9c6bfa0f256b9deba10d76c7698329afde` |
| PactSettler | `0xe461ce50ef53bfc10945b101fb94b11ec5eb591f` |

| network | chainId | USDC | RPC |
|---------|---------|------|-----|
| arc-testnet | `5042002` | `0x3600000000000000000000000000000000000000` (USDC is also the gas token) | `https://rpc.testnet.arc.network` |
| base-sepolia | `84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `https://sepolia.base.org` |
| base-mainnet (future) | `8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | — |

- EVM settler signer / registry authority (testnet): `0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859` (holds SETTLER_ROLE + ADMIN; IS the `registerEndpoint` authority on both EVM chains).
- Settler EVM key env: `PACT_SETTLER_KEYPAIR_<NETWORK>` (0x-hex), e.g. `PACT_SETTLER_KEYPAIR_ARC_TESTNET`, `PACT_SETTLER_KEYPAIR_BASE_SEPOLIA`.
- EVM endpoints register a slug as bytes16 (e.g. `e2e-test-slug-01`). There is **no unregister** ix (only `pauseEndpoint`) — register deliberately.

---

## C. Verified live (2026-05-29 multi-chain settle proof)
| network | slug used | real upstream hit | settle tx |
|---------|-----------|-------------------|-----------|
| solana-devnet | `dummy` | `https://api.devnet.solana.com` (getBalance) | `4Gksg…Mgsfp` (finalized) |
| arc-testnet | `e2e-test-slug-01`→dummyHandler | `https://lite-api.jup.ag/price/v3` | `0x08060bc0…de93fe` |
| base-sepolia | `e2e-test-slug-01`→dummyHandler | `https://lite-api.jup.ag/price/v3` | `0xc480a7ca…b440c` |

All three: real signed call → premium 10000 → on-chain settleBatch → fee split agent −10000 / pool +8500 / treasury +1000 / affiliate +500.
