# Curated Endpoint Registration Plan (for Rick)

Compiled 2026-05-29. **Plan only — no on-chain txs, no DB writes, no mainnet executed by this branch.**

Goal: turn each of the **7 production-curated providers** into a LIVE insured endpoint. After the
`chore/curated-endpoints-moralis-covalent` PR (#247), all 7 are first-class in code
(`ENDPOINT_SLUGS`, `DEFAULT_UPSTREAM_BASE`, market-proxy handlers/classifiers/hostnames). What
remains to make any one of them *live* on a given network is three steps: **(A) on-chain register**,
**(B) off-chain DB row**, **(C) provider secret**.

The 7 curated slugs: `helius, birdeye, jupiter, elfa, fal, moralis, covalent`.
(`dummy` = demo, `pay-default` = facilitator-only — intentionally NOT curated.)

Each step below is split into a **Rick-block** (needs mainnet/prod permissions Tu does not have —
see memory `gcp_ownership`, `devnet_keys`) and a **local/testnet-block** (we can do).

---

## Step A — ON-CHAIN register (`register_endpoint` / `registerEndpoint`)

One registration per `(network, slug)`. Registration is **deliberate and near-permanent**: Solana
has no de-register ix (only pause via `update_config`); EVM has no unregister (only `pauseEndpoint`).

### A.1 — Solana instruction shape

Source: `packages/protocol-v1-client/src/instructions.ts` → `buildRegisterEndpointIx(RegisterEndpointParams)`
(discriminator `DISC_REGISTER_ENDPOINT`). Atomically allocates `EndpointConfig` PDA + slug-keyed
`CoveragePool` PDA + pool USDC vault.

**Args (instruction data):**
| field | type | notes |
|-------|------|-------|
| `slug` | `Uint8Array` (16 bytes, UTF-8, zero-padded) | the curated slug, e.g. `moralis` |
| `flatPremiumLamports` | `bigint` (u64) | USDC base units (6dp). Reference: `1000` = $0.001/call |
| `percentBps` | `number` (u16) | reference production value `0` (flat-only) |
| `slaLatencyMs` | `number` (u32) | per-provider SLA; dummy uses `2000` |
| `imputedCostLamports` | `bigint` (u64) | refund on covered failure; dummy uses `10000` |
| `exposureCapPerHourLamports` | `bigint` (u64) | rolling-hour pool payout cap; dummy uses `1000000` |
| `feeRecipients?` | `FeeRecipient[]` | OMIT to copy `ProtocolConfig.default_fee_recipients`; if set, pass `feeRecipientCount` = length. Each entry: `{ kind, destination, bps }` — kind 0=Treasury, 1=AffiliateAta, 2=AffiliatePda. 48 bytes each. |
| `affiliateAtas?` | `PublicKey[]` | one per `AffiliateAta` entry, in order. Required when the effective fee_recipients array has ≥1 AffiliateAta. |

**Accounts (in order):**
| # | account | signer | writable | notes |
|---|---------|--------|----------|-------|
| 0 | `authority` | ✅ | ✅ | **must equal `ProtocolConfig.authority`** (the protocol authority) |
| 1 | `protocolConfig` | | | ProtocolConfig PDA |
| 2 | `treasury` | | | Treasury PDA |
| 3 | `endpointConfig` | | ✅ | PDA `[b"endpoint", slug]` |
| 4 | `coveragePool` | | ✅ | PDA `[b"coverage_pool", slug]` |
| 5 | `poolVault` | | ✅ | pre-allocated 165-byte SPL token account (owner = TOKEN_PROGRAM) |
| 6 | `usdcMint` | | | protocol USDC mint |
| 7 | `system_program` | | | |
| 8 | `token_program` | | | |
| 9.. | `affiliate_ata_0..M-1` | | | one per AffiliateAta entry |

PDA helpers + `FeeRecipient`/`FeeRecipientKind` types are in the same package (`pda.ts`).

**Who can register (Solana):** the **protocol authority** = `ProtocolConfig.authority`. (Per memory
`endpoint registration requires protocol upgrade authority` — confirm the live ProtocolConfig.authority
on each cluster before signing.)

### A.2 — EVM instruction shape

Source: `packages/protocol-evm-v1-client/src/encode.ts` → `encodeRegisterEndpoint(RegisterEndpointInput)`;
ABI `packages/protocol-evm-v1-client/src/abi/PactRegistry.ts`.

**Function signature:**
```
registerEndpoint(
  bytes16 slug,
  uint64  flatPremium,
  uint16  percentBps,
  uint32  slaLatencyMs,
  uint64  imputedCost,
  uint64  exposureCapPerHour,
  bool    feeRecipientsPresent,
  uint8   feeRecipientCount,
  FeeRecipient[8] feeRecipients   // fixed-length 8; zero-pad unused (padFeeRecipients)
)
```
`FeeRecipient = { uint8 kind; address destination; uint16 bps }` (kind 0/1/2 preserved). Slug is
`bytes16` (UTF-8 right-padded; `slugToBytes16`). Send to **PactRegistry** at
`0x056bac33546b5b51b8cf6f332379651f715b889c`.

**Who can register (EVM):** the **registry authority** `0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859`
(holds SETTLER_ROLE + ADMIN on both EVM testnets; IS the `registerEndpoint` authority). On testnets
this is the same key as the settler signer.

### A.3 — Per-network checklist

| network | program / registry | authority | block |
|---------|--------------------|-----------|-------|
| **solana-mainnet** `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` | V1 program | ProtocolConfig.authority (mainnet) | **Rick** (mainnet keys, see `devnet_keys`/`gcp_ownership`) |
| **solana-devnet** `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` | V1 program | `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` | local/testnet (Tu can do with devnet bundle) — **but see FS9 caveat** |
| **arc-testnet** `5042002` | PactRegistry `0x056b…889c` | `0x777d…B859` | local/testnet (Tu) |
| **base-sepolia** `84532` | PactRegistry `0x056b…889c` | `0x777d…B859` | local/testnet (Tu) |

> **FS9 caveat (devnet only):** deployed `5jBQ` predates the `protocol_config` kill-switch — the client
> sends 5 fixed accounts, the deployed program expects 4 → `InvalidSeeds` on `settle_batch`. Registration
> itself may still work, but devnet is a known pre-mainnet redeploy blocker (memory
> `solana_program_client_drift`). Mainnet `5bCJ` is the 5-account shape and is fine.

EVM contracts (PactPool `0xa613…afde`, PactSettler `0xe461…591f`) are shared across arc-testnet and
base-sepolia (deterministic addresses).

---

## Step B — OFF-CHAIN DB row (`Endpoint`)

Source schema: `packages/db/prisma/schema.prisma` → `model Endpoint`, **composite PK `@@id([network, slug])`**.
Reference seed shape: `packages/db/seeds/dummy-endpoint.ts` (+ `.sql`).

| column | source of truth | notes |
|--------|-----------------|-------|
| `network`, `slug` | operator | composite key, one row per (network, slug) |
| `flatPremiumLamports`, `percentBps`, `slaLatencyMs`, `imputedCostLamports`, `exposureCapPerHourLamports`, `paused` | **on-chain** | overwritten every 5 min by `OnChainSyncService` once the EndpointConfig PDA / EVM endpoint exists; seed values are placeholders until then |
| `upstreamBase` | **auto-filled** | the indexer fills this from `DEFAULT_UPSTREAM_BASE[slug]` on first create (now includes moralis/covalent). Operator may override via ops UI; sync does not clobber it on update |
| `displayName` | operator (off-chain) | e.g. "Moralis Web3 API" |
| `logoUrl` | operator (off-chain), nullable | |
| `registeredAt`, `lastUpdated` | set on upsert | |

**Mechanics:** because `DEFAULT_UPSTREAM_BASE` now has moralis + covalent, a freshly-registered
on-chain endpoint auto-materializes a correct DB row (with upstreamBase) on the next sync tick —
no manual `upstreamBase` write needed. A seed (like `dummy-endpoint.ts`) is only needed to pre-stage
`displayName`/`logoUrl` or to stand in before the chain row exists. After any manual DB change, hot-reload
the proxy: `POST /admin/reload-endpoints` with `Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN`.

- **Rick-block:** prod/mainnet Cloud SQL writes (Tu has no Cloud SQL access — memory `gcp_ownership`).
- **local/testnet-block:** devnet/testnet Postgres seeding + proxy reload (Tu can do; the
  seed scripts refuse prod URLs unless `ALLOW_PROD_SEED=1`).

---

## Step C — Provider SECRETS (Rick must provision per environment)

The market-proxy reads upstream auth at request time. Exact behavior per handler
(`packages/market-proxy/src/endpoints/*.ts`):

| slug | auth model | secret / env var | who provisions |
|------|-----------|------------------|----------------|
| `helius` | key in query string `?api-key=`, **injected server-side** | **`PACT_HELIUS_API_KEY`** (only handler that reads an env var today) | Rick (Secret Manager) |
| `birdeye` | `X-API-KEY` header, **caller passthrough** | caller-supplied; no proxy env. If operator-injected desired, not yet wired | Rick decides model |
| `moralis` | `X-API-KEY` header, **caller passthrough** | caller-supplied; no proxy env today | Rick decides model |
| `covalent` | `Authorization: Bearer`, **caller passthrough** | caller-supplied; no proxy env today | Rick decides model |
| `elfa` | `Authorization: Bearer`, intended operator-injected | handler **strips** caller auth (`EXTRA_ALLOWED` empty) but **does not yet read an env var** — injection is a code TODO (`elfa.ts`) | Rick + code follow-up |
| `fal` | `Authorization: Key <key>`, intended operator-injected | same: handler strips caller auth, **no env read yet** (`fal.ts` TODO) | Rick + code follow-up |
| `jupiter` | **keyless** (lite-api.jup.ag tier) | none | — |

> **Accuracy flag:** only `helius` actually injects a secret from env (`PACT_HELIUS_API_KEY`).
> `birdeye`/`moralis`/`covalent` pass the caller's auth header through. `elfa`/`fal` *strip* caller
> auth and have a comment saying "operator-injected" but the env-var injection is **not implemented** —
> if Rick wants those live with a proxy-held secret, that needs a small handler change first (read
> e.g. `PACT_ELFA_API_KEY` / `PACT_FAL_API_KEY` and set the header). Naming TBD with Tu.

Always-required proxy env (not provider-specific): `ENDPOINTS_RELOAD_TOKEN` (min 16 chars) to allow
`/admin/reload-endpoints`.

---

## Step D — PRODUCT decision (Rick / Tu confirm before mainnet)

`flatPremiumLamports`, `percentBps`, `slaLatencyMs`, `imputedCostLamports`, `exposureCapPerHourLamports`,
and the **fee-recipient split** (treasury bps + affiliate bps) are **product decisions**, not derivable
from code. Reference values currently in the codebase (dummy/helius):

- `flatPremiumLamports = 1000` ($0.001/call), well above `MIN_PREMIUM_LAMPORTS = 100`
- `percentBps = 0` (flat-only — all production endpoints)
- `slaLatencyMs = 2000` (dummy), `imputedCostLamports = 10000`, `exposureCapPerHourLamports = 1000000` (demo-scale)
- fee split: Treasury + Affiliate(s) via `ProtocolConfig.default_fee_recipients` (e.g. observed devnet
  split pool +8500 / treasury +1000 / affiliate +500 on a 10000 premium)

**Action for Rick/Tu:** confirm per-provider production premium, SLA, imputed-cost, exposure cap, and
the treasury/affiliate bps split before registering on mainnet `5bCJ`.

---

## Suggested order of operations (per provider, per network)

1. (Rick/Tu) Decide product values (Step D).
2. (authority) `register_endpoint` / `registerEndpoint` (Step A) → creates EndpointConfig + pool.
3. Indexer sync tick auto-creates the DB row with the correct `upstreamBase` (Step B, auto).
4. (optional) Seed `displayName`/`logoUrl`; `POST /admin/reload-endpoints`.
5. (Rick) Provision provider secret if the handler injects one (Step C — today: helius only).
6. Smoke a real insured call through `/v1/<slug>/…` and confirm a settle event + fee split.
