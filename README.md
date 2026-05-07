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

## Monorepo Structure

```
packages/
  sdk/        @q3labs/pact-monitor    TypeScript SDK wrapping fetch()
  insurance/  @q3labs/pact-insurance  Agent-side SDK for on-chain policies (Phase 3)
  backend/    @pact-network/backend    Fastify API server + PostgreSQL + Solana crank
  scorecard/  @pact-network/scorecard  Vite + React + Tailwind dashboard
  program/                             Anchor program (Solana on-chain insurance)
deploy/                                Docker Compose + GCP deployment configs
docs/                                  PRD, design spec, Phase 3 implementation plan
scripts/                               Setup automation
```

## Tech Stack

| Layer     | Technology                              |
| --------- | --------------------------------------- |
| Language  | TypeScript (strict, ES2022)             |
| Backend   | Fastify 5, PostgreSQL 16, pg            |
| Frontend  | React 19, Vite 6, Tailwind CSS, Recharts |
| SDK       | Zero dependencies, wraps native fetch() |
| Deploy    | Docker, GCP Cloud Run, GCR              |
| Tooling   | pnpm workspaces, tsx                    |

## Quick Start

Prerequisites: Node.js 20+, pnpm, Docker.

```bash
# One-command setup: install deps, start PostgreSQL, create .env, generate API key, seed data
pnpm run setup
```

Then start the dev servers:

```bash
pnpm dev:backend      # API server on port 3001
pnpm dev:scorecard    # Dashboard on port 5173
```

Open http://localhost:5173 to see the scorecard.

### Manual Setup

```bash
pnpm install

# Build all workspace packages in dependency order (monitor → insurance →
# backend → scorecard). Required before `pnpm dev:backend` because the
# backend's tsc resolves @q3labs/pact-insurance from its dist/.
pnpm build

# Start PostgreSQL (port 5433)
pnpm run db:up

# Copy environment config
cp .env.example packages/backend/.env

# Generate an API key
pnpm run generate-key dev-agent

# Seed with realistic data for 5 Solana providers
pnpm run seed

# Start servers
pnpm dev:backend
pnpm dev:scorecard
```

## SDK Usage

```typescript
import { pactMonitor } from "@q3labs/pact-monitor";

const monitor = pactMonitor({
  backendUrl: "https://pactnetwork.io/api/v1",
  apiKey: "pact_...",
});

// Use monitor.fetch() as a drop-in replacement for fetch()
const response = await monitor.fetch("https://api.helius.xyz/v0/...", {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", method: "getBalance", params: [...] }),
});
```

The SDK silently records call metadata (latency, status, failure classification) and syncs it to the backend. If the monitor fails for any reason, the underlying API call still succeeds.

The SDK extracts x402/MPP payment headers when present, capturing payment data alongside reliability metrics.

## API Endpoints

| Method | Path                              | Auth     | Description                          |
| ------ | --------------------------------- | -------- | ------------------------------------ |
| POST   | `/api/v1/records`                 | Required | Batch ingest call records            |
| GET    | `/api/v1/providers`               | Public   | Ranked provider list with rates      |
| GET    | `/api/v1/providers/:id`           | Public   | Provider detail (incl. `hostname`)   |
| GET    | `/api/v1/providers/:id/timeseries`| Public   | Failure rate over time (hourly/daily)|
| GET    | `/api/v1/pools`                   | Public   | On-chain coverage pools (Phase 3)    |
| GET    | `/api/v1/pools/:hostname`         | Public   | Pool detail + positions + claims     |
| POST   | `/api/v1/claims/submit`           | Internal | Submit a claim on-chain via oracle   |
| GET    | `/health`                         | Public   | Server health check                  |

Authentication uses Bearer tokens: `Authorization: Bearer pact_...`

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

Production services are containerized and deployed to **Google Cloud Platform**:

- **Container Registry (GCR)** hosts Docker images for the backend and scorecard
- **Cloud Run** runs the backend and scorecard as managed services
- **Cloud SQL (PostgreSQL 16)** for the production database

Each package has a Dockerfile for building production images. The `deploy/` directory contains orchestration configs for local staging and reference.

Production runs on [pactnetwork.io](https://pactnetwork.io).

## Design

Brutalist aesthetic. No gradients, no rounded corners, no emojis.

- **Background:** #151311
- **Copper:** #B87333 (financial values, insurance rates)
- **Burnt Sienna:** #C9553D (failures, violations, HIGH RISK)
- **Slate:** #5A6B7A (healthy, RELIABLE)
- **Fonts:** Inria Serif (headlines), Inria Sans (body), JetBrains Mono (data)

## Phase 3: On-Chain Insurance (Solana)

The Anchor program at `packages/program/` lifts the parametric insurance from a simulated DB row into a real on-chain market. See [`docs/PHASE3.md`](./docs/PHASE3.md) for the full design, devnet state, and operator runbook.

For canonical mainnet + devnet program IDs, see [On-chain Programs](#on-chain-programs) above.

**New here?** Three docs to read in order:
1. [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) — narrative walkthrough for someone who knows nothing
2. [`docs/STRUCTURE.md`](./docs/STRUCTURE.md) — file-tree map of the whole monorepo
3. [`docs/PHASE3.md`](./docs/PHASE3.md) — architecture handbook + operator runbook

**Highlights**:
- Per-provider `CoveragePool` PDAs with PDA-owned SPL token vaults
- Underwriters deposit USDC for yield; cooldown-enforced withdrawals
- **SPL token delegation** model — agents call `spl_token::approve` once and the protocol pulls premiums from their wallet per call. No prepaid balance, no upfront deposit.
- Backend crank (`packages/backend/src/crank/`) settles premiums and pushes rate updates
- Aggregate payout cap (default 30% / 24h) with hardcoded ceiling
- Auto-approved parametric claims with PDA-collision dedupe

## Roadmap

- **Multi-chain support** -- extend monitoring beyond Solana to EVM chains and cross-chain bridges
- **Agent-to-agent marketplace** -- allow AI agents to purchase insurance policies directly, settling in SOL or stablecoins
- **Historical analytics API** -- expose long-term provider reliability trends, seasonal patterns, and predictive risk scores
- **SDK plugins** -- framework-specific integrations (LangChain, CrewAI, AutoGPT) for zero-config monitoring
- **Webhook alerts** -- notify agent operators in real-time when provider reliability degrades past configurable thresholds
- **Provider self-service** -- allow API providers to register, view their own metrics, and dispute classifications

## License

Proprietary. All rights reserved.
