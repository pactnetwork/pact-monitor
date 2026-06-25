# Pact Network

Parametric micro-insurance for AI agent API payments on Solana. Pact Network monitors API provider reliability in real-time, computes actuarially-derived insurance rates from observed failure data, and publishes those rates on a public scorecard. The insurance rate is the product.

## How It Works

1. **SDK** wraps `fetch()` in your AI agent, recording every API call (latency, status, payment headers)
2. **Backend** ingests call records, aggregates failure rates, and computes insurance pricing per provider
3. **Scorecard** displays a public, ranked dashboard of provider reliability and insurance rates

Insurance rate formula: `max(0.001, failureRate * 1.5 + 0.001)`

Provider tiers:
- **RELIABLE** — failure rate < 1%
- **ELEVATED** — failure rate 1%--5%
- **HIGH RISK** — failure rate > 5%

## On-chain Programs

V1 (Pinocchio 0.10, ~88 KB binary): per-endpoint coverage pools, agent SPL-Approve custody, fee fan-out, on-chain `pause_protocol` kill switch.

### Mainnet — production

| | |
|---|---|
| **Program ID** | [`5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc`](https://explorer.solana.com/address/5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc) |
| **Upgrade authority** | `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL` |
| **ProgramData** | `6iRJjfUMq4xqFbTSsF2dC2ARv6K3MFWSvCHcVwnrHhoN` |
| **Loader** | `BPFLoaderUpgradeable11111111111111111111111` |
| **Binary size** | 88,680 bytes |
| **First deploy** | 2026-05-07, slot `418138207` |
| **Status** | Live; private beta |

The mainnet upgrade authority is currently a laptop hot key. **Rotation to a Squads multisig is scheduled within 2-4 weeks of launch.** The protocol authority + Treasury authority share this same key for V1 simplicity.

### Devnet — testing

| | |
|---|---|
| **Program ID** | [`5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`](https://explorer.solana.com/address/5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5?cluster=devnet) |
| **Upgrade authority** | `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` (hot key — fine for devnet) |
| **Status** | Used for end-to-end smoke / integration tests |

### Orphans — do NOT target

Earlier deploys that should not be referenced by any client. Listed only so log scrapers and migration tooling can recognise legacy traffic.

| Program ID | Network | Reason |
|---|---|---|
| `DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc` | devnet | pre-Step-C Wave 1A binary; original upgrade authority lost |

These addresses are also exported as constants in `packages/protocol-v1-client/src/constants.ts` (`PROGRAM_ID`, `ORPHAN_PROGRAM_ID_PRE_STEP_C`, `ORPHAN_PROGRAM_ID_DEVNET_STEP_C`).

### EVM — Base Mainnet (production)

Full-stack EVM deployment on **Base mainnet** (chainId **8453**), deployed 2026-06-04 at block `46880730`. This is the production EVM deployment of the Pact Network V1 contracts.

| Contract | Address |
|---|---|
| **PactRegistry** | [`0x8cf7Dd83877a6a254bf05E31A79d50bC7169221D`](https://basescan.org/address/0x8cf7Dd83877a6a254bf05E31A79d50bC7169221D) |
| **PactPool** | [`0xA3245C40d9C8448eeA03847CD2BFdDe41f7c14A4`](https://basescan.org/address/0xA3245C40d9C8448eeA03847CD2BFdDe41f7c14A4) |
| **PactSettler** | [`0x21adb7C1aD28b332661DaB8d52d765610dBF162A`](https://basescan.org/address/0x21adb7C1aD28b332661DaB8d52d765610dBF162A) |
| **USDC** (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base mainnet USDC) |

- **Deploy block:** `46880730` · **Status:** Production (live). Keys at `~/.pact-keys/base-mainnet/`. The EVM `authority` is immutable (no setter on the contracts); the settler key can be rotated via `SETTLER_ROLE` AccessControl.

### EVM — Arbitrum Sepolia (testnet / buildathon demo)

Full-stack EVM deployment on **Arbitrum Sepolia** (chainId **421614**), built for the Arbitrum Open House London Online Buildathon. The EVM stack is chain-agnostic — this is a new chain entry plus a new deployment of the existing contracts, no forked code. Full runbook in [`DEPLOY-ARBITRUM-SEPOLIA.md`](./DEPLOY-ARBITRUM-SEPOLIA.md).

| Contract | Address |
|---|---|
| **PactRegistry** | [`0x79A91E5965094266d221Aaef8E66d6C364819edb`](https://sepolia.arbiscan.io/address/0x79A91E5965094266d221Aaef8E66d6C364819edb) |
| **PactPool** | [`0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc`](https://sepolia.arbiscan.io/address/0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc) |
| **PactSettler** | [`0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043`](https://sepolia.arbiscan.io/address/0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043) |
| **USDC** (Circle test) | [`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`](https://sepolia.arbiscan.io/address/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d) |

| Role / value | Address |
|---|---|
| Deployer / authority (permanent, no setter) | `0xFaFE88B744B53e66CD2896E77EAB3De0D9Ab3f53` |
| Treasury vault (permanent, no setter) | `0x130bcfAd4d405dB3EF296B76a052180bB5a9c176` |
| Off-chain settler signer (`SETTLER_ROLE`) | `0x232132df53665D3E6987E40Bab6Ee59E0d043822` |

- **Deploy block:** `276425280` · **Deploy tx:** [`0x1034450c…`](https://sepolia.arbiscan.io/tx/0x1034450c958fcaa7932e6c3133d30c078681c17a63c032deeae09db60c837817) · all 3 contracts Arbiscan-verified.
- **E2E proof — insured call → SLA breach → on-chain refund:** [`0x4754ee52…`](https://sepolia.arbiscan.io/tx/0x4754ee52f0fd04bb3383897a4ae772f3a6dae1c331ad167565e6499db310b6b1) (`settleBatch`, block 276472305).
- Chain entry synced across `config/chains.json`, `packages/shared/src/chains.ts`, `packages/protocol-evm-v1-client/src/constants.ts`; addresses in `addresses.ts` `DEPLOYMENTS[421614]`.

Live stack (Railway, project `pact-arbitrum-sepolia`):

| Service | URL |
|---|---|
| Dashboard | https://market-dashboard-production-0489.up.railway.app |
| Insured proxy | https://market-proxy-production-29f9.up.railway.app |
| Indexer API | https://indexer-production-52a9.up.railway.app |

## Monorepo Structure

pnpm + Turborepo workspace. 19 active packages grouped by layer:

```
packages/
  # On-chain programs
  program/programs-pinocchio/pact-network-v1-pinocchio/  Solana V1 (Pinocchio 0.10)
  program/programs-pinocchio/pact-network-v2-pinocchio/  Solana V2 (future — not deployed)
  program-evm/protocol-evm-v1/                           EVM V1 (Solidity: Pool/Settler/Registry)
  program/programs/pact-insurance/                       Legacy Anchor crate (do not modify)

  # Protocol clients (TypeScript)
  protocol-v1-client/    @q3labs/pact-protocol-v1-client  Solana V1 PDAs, ix builders, error map
  protocol-evm-v1-client/                                 EVM V1 ABI, address registry, state

  # Rails — generic off-chain
  shared/        Multi-VM abstraction (ChainAdapter, Solana+EVM adapters, shared types)
  wrap/          Generic fetch-call insurance (wrapFetch, Classifier, EventSink, X-Pact-* headers)
  settler/       Pub/Sub → settle_batch submitter (NestJS)
  indexer/       Per-call ingest + read API + refund delivery + reorg handling (NestJS)
  db/            Prisma schema (Postgres)
  classifier/    @pact-network/classifier  SLA outcome classifier (extracted from wrap)

  # Pact Market — the hosted interface
  market-proxy/      Hono proxy wrapping curated providers (Helius, Birdeye, Jupiter, Elfa, fal.ai)
  market-dashboard/  Next.js 15 dashboard (App Router, Tailwind 4, wallet-adapter)

  # Client / SDK / tooling
  sdk/           @q3labs/pact-sdk        Agent-side unified SDK (createPact, golden-fetch, signing)
  cli/           @q3labs/pact-cli        Operator + agent command line
  facilitator/   x402-style premium-coverage register service
  monitor/       @q3labs/pact-monitor    Legacy reliability-monitor SDK (pre-Step-A)
  insurance/     @q3labs/pact-insurance  Legacy V2 agent-side Solana client (pre-Step-A)
  backend/       @pact-network/backend   Live Market control-plane (Fastify): beta gate,
                                         API-key issuance, CRM, faucet, legacy scorecard
  scorecard/     @pact-network/scorecard Legacy public-scorecard frontend (Vite/React)
  dummy-upstream/                        Keyless test upstream for smoke tests

docs/        Architecture, runbooks, onboarding, ADRs
deploy/      Docker Compose + GCP Cloud Run configs
scripts/     Repo-level automation
```

## Tech Stack

| Layer          | Technology                                                              |
| -------------- | ----------------------------------------------------------------------- |
| Language       | TypeScript (strict, ES2022), Rust/Pinocchio 0.10 (Solana), Solidity (EVM) |
| Services       | NestJS (settler, indexer), Hono (market-proxy), Fastify (backend/control-plane) |
| Database       | PostgreSQL 16, Prisma ORM                                               |
| Dashboard      | Next.js 15 (App Router), Tailwind 4, shadcn/ui, wallet-adapter         |
| SDK            | ESM-only, no runtime deps, wraps native fetch()                         |
| Solana client  | `@solana/web3.js` 1.x, `@solana/kit` 2.x, hand-written decoders       |
| EVM client     | viem, Foundry (contract tests)                                          |
| Deploy         | Docker, GCP Cloud Run, Cloud SQL, Pub/Sub; Railway (devnet mirror)     |
| Tooling        | pnpm workspaces, Turborepo, Vitest, LiteSVM (Bun), surfpool            |

## Quick Start

Prerequisites: Node.js 20+, pnpm 9+, Docker.

```bash
pnpm install
pnpm build           # build all packages in dependency order
pnpm run db:up       # start Postgres on port 5433
cp .env.example packages/backend/.env
pnpm run generate-key dev-agent
pnpm run seed        # seed 5 Solana provider records
pnpm dev:backend     # legacy Fastify control-plane on port 3001
pnpm dev:scorecard   # legacy scorecard on port 5173
```

For the live-stack services (indexer, settler, market-proxy, market-dashboard), see each package's `README.md` and the Railway devnet runbook at [`docs/devnet-railway-deploy.md`](./docs/devnet-railway-deploy.md).

## SDK Usage

Install the unified agent SDK (`@q3labs/pact-sdk`) — **not** the legacy `@q3labs/pact-monitor`:

```bash
npm install @q3labs/pact-sdk
```

```typescript
import { createPact } from "@q3labs/pact-sdk";
import { Keypair } from "@solana/web3.js";

const pact = await createPact({
  network: "mainnet",
  signer: Keypair.fromSecretKey(/* your 64-byte ed25519 secret */),
});

// One-time: global SPL approve to the SettlementAuthority delegate.
await pact.setup({ allowanceUsdc: 5 });

// Drop-in fetch. Covered calls route through the Pact Market proxy.
const res = await pact.fetch("https://api.helius.xyz/v0/addresses/…");

pact.on("refund",  (e) => { /* USDC settled back on-chain on breach */ });
pact.on("billed",  (e) => { /* premium settled on-chain */ });
pact.on("degraded",(e) => { /* fell back to bare fetch — call still succeeded */ });
```

`pact.fetch()` behaves exactly like `fetch()`. Any Pact-internal problem (unregistered host, unreachable proxy, missing key) silently falls back to a bare fetch and emits `degraded` — the underlying call always completes.

The package is ESM-only; there is no CJS export. Node ≥ 18 required.

For the legacy reliability-monitor SDK (`@q3labs/pact-monitor`), see `packages/monitor/`.

## API Endpoints

### Indexer API (`indexer.pactnetwork.io`) — primary read surface

| Method | Path              | Auth   | Description                              |
| ------ | ----------------- | ------ | ---------------------------------------- |
| GET    | `/api/endpoints`  | Public | Live endpoint list with pool state       |
| GET    | `/api/stats`      | Public | Aggregate stats (pools, calls, breaches) |
| GET    | `/api/calls`      | Public | Settled call records (paginated)         |
| POST   | `/events`         | Internal | Ingest settlement outcomes from settler |
| GET    | `/health`         | Public | Service health check                     |

### Facilitator API (`facilitator.pact.network`) — pay.sh / x402 coverage register

| Method | Path                       | Auth               | Description                        |
| ------ | -------------------------- | ------------------ | ---------------------------------- |
| POST   | `/v1/coverage/register`    | ed25519 signature  | Register a pay.sh call for coverage|

### Legacy Backend API (`pactnetwork.io/api/v1`) — control-plane / scorecard

| Method | Path                               | Auth     | Description                            |
| ------ | ---------------------------------- | -------- | -------------------------------------- |
| POST   | `/api/v1/records`                  | Required | Batch ingest call records (legacy SDK) |
| GET    | `/api/v1/providers`                | Public   | Ranked provider list with rates        |
| GET    | `/api/v1/providers/:id`            | Public   | Provider detail                        |
| GET    | `/api/v1/providers/:id/timeseries` | Public   | Failure rate over time                 |
| GET    | `/health`                          | Public   | Server health check                    |

> **Cloud Armor note:** `api.pactnetwork.io` and `indexer.pactnetwork.io` 403 default curl/Node User-Agents. Use a browser UA or `pact-monitor-sdk/0.1.0`.

## Scripts

```bash
pnpm run setup          # Full dev environment setup
pnpm dev:backend        # Start backend in watch mode
pnpm dev:scorecard      # Start scorecard dev server
pnpm build              # Build all packages
pnpm test               # Run all tests (SDK + backend)
pnpm run seed           # Re-seed the database
pnpm run generate-key <label>  # Generate a new API key
pnpm run db:up          # Start PostgreSQL container
pnpm run db:down        # Stop PostgreSQL container
pnpm run db:reset       # Reset database (destroy + recreate)
```

## Testing

```bash
pnpm test               # All tests
pnpm test:sdk           # SDK unit tests (classifier, payment extraction, storage)
pnpm test:backend       # Backend tests (API routes, insurance formula)
```

## Production Deployment

### Solana mainnet (GCP)

Core services run on **Google Cloud Platform**:

| Service | URL |
|---|---|
| Market proxy | https://market.pactnetwork.io |
| Indexer | https://indexer.pactnetwork.io |
| Settler | (internal, no public URL) |
| Dashboard | https://dashboard.pactnetwork.io |
| Control-plane backend | https://pactnetwork.io |

Infrastructure: Cloud Run (services), Cloud SQL Postgres 16, Cloud Pub/Sub (settler queue), Secret Manager (keys), GCR (images).

### Devnet Railway mirror

A full devnet stack (5 services) runs on **Railway**, branch `develop`, project `pact-network-devnet`. See [`docs/devnet-railway-deploy.md`](./docs/devnet-railway-deploy.md) for the full runbook.

### EVM (Base mainnet, Arbitrum Sepolia)

The EVM stack is chain-agnostic. Production EVM deployment is on Base mainnet (see [On-chain Programs](#on-chain-programs)). The Arbitrum Sepolia stack is a Railway-hosted testnet demo (see the Arbitrum Sepolia section above).

Contact: rick@quantum3labs.com · Telegram: t.me/metalboyrick

## Design

Brutalist aesthetic. No gradients, no rounded corners, no emojis.

- **Background:** #151311
- **Copper:** #B87333 (financial values, insurance rates)
- **Burnt Sienna:** #C9553D (failures, violations, HIGH RISK)
- **Slate:** #5A6B7A (healthy, RELIABLE)
- **Fonts:** Inria Serif (headlines), Inria Sans (body), JetBrains Mono (data)

## On-Chain Insurance Architecture

The Solana V1 program (`packages/program/programs-pinocchio/pact-network-v1-pinocchio/`) is the production on-chain layer. For canonical mainnet + devnet program IDs, see [On-chain Programs](#on-chain-programs) above.

**New here?** Read in order:
1. [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) — narrative walkthrough for someone who knows nothing
2. [`docs/architecture/ARCHITECTURE.en.md`](./docs/architecture/ARCHITECTURE.en.md) — full architecture reference, multi-VM seam, package map, deployment topology

**V1 highlights** (Pinocchio, currently live on Solana mainnet):
- Per-endpoint `CoveragePool` PDAs — pool-as-residual settlement model
- **SPL token delegation** — agents call `spl_token::approve` once; the protocol pulls premiums per call. No prepaid balance, no upfront deposit.
- Singleton `SettlementAuthority` PDA + per-agent fee-split to treasury and integrator
- `pause_protocol` kill switch
- The settler submits `settle_batch` on-chain; refunds happen atomically on classified breach

**V2 (Solana, not yet deployed)** — `pact-network-v2-pinocchio`: multi-underwriter parametric model with `Policy` PDA, `enable_insurance`, oracle claims, underwriter deposits/withdrawals. The `Policy` struct carries a `double_coverage` seam (agent-tasks#17) with a `discount_scope` field for merchant-configurable coverage discounts. Not production; no deploy yet.

**EVM V1** — 3-contract Solidity set (`PactRegistry`, `PactPool`, `PactSettler`) deployed on Base mainnet (production) and Arbitrum Sepolia (testnet). The EVM `authority` is immutable (no setter); settler key is rotatable via `SETTLER_ROLE` AccessControl.

## Roadmap

**Shipped:**
- **Multi-chain support** — Solana mainnet + Base mainnet (EVM) production; Arbitrum Sepolia testnet. ChainAdapter abstraction in `packages/shared/` supports adding chains without touching settler/indexer/proxy.
- **Multi-network ChainAdapter** — hexagonal ports-and-adapters design; `SolanaAdapter` + `EvmAdapter` both live.

**In progress:**
- **Merchant SDK** (PR #223) — SDK surface for API providers / merchants to integrate coverage on the sell side.
- **Dashboard rename to Pact Explorer** (PR #274) — brand rename + self-hosted fonts + bug fixes.
- **Escrow-hold PoC** (PR #249) — alternative risk mode for high-value calls (Krexa integration).

**Planned:**
- **Historical analytics API** — long-term provider reliability trends, seasonal patterns, predictive risk scores.
- **SDK plugins** — framework-specific integrations (LangChain, CrewAI, AutoGPT) for zero-config monitoring.
- **Webhook alerts** — notify agent operators when provider reliability degrades past configurable thresholds.
- **Provider self-service** — allow API providers to register, view their own metrics, and dispute classifications.
- **V2 Solana program** — multi-underwriter parametric insurance with `Policy` PDA and oracle claims.

## License

Proprietary. All rights reserved.
