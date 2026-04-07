# Pact Network MVP — Design Spec

> v1.0 | 2026-04-07
> Deadline: April 12, 2026 (Colosseum hackathon)
> Author: Rick (Product) | Engineering: Alan
> PRD: docs/prd-phases-1-2.pdf

## Overview

Pact Network is parametric insurance for AI agent API payments on Solana. Agents pay for APIs via x402/MPP protocols but have zero buyer protection. Pact monitors API reliability, publishes a public scorecard with computed insurance rates, and builds the data foundation for on-chain insurance (Phase 3, out of scope).

**"The insurance rate is the product. Everything else exists to make that number real, accurate, and public."**

## Scope — Phases 1 & 2 Only

- Phase 1: Pact Monitor (SDK + Backend) — collect reliability data
- Phase 2: Reliability Scorecard — public dashboard with insurance rates
- NOT in scope: on-chain programs, insurance pools, underwriters, payment processing, user self-registration, mobile UI, landing page

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| SDK | TypeScript, wraps fetch(), JSON file local storage |
| Backend | Fastify + PostgreSQL |
| Scorecard | Vite + React + Tailwind CSS + Recharts |
| Insurance Rate | Computed server-side in backend |
| Deployment | Docker Compose + Caddy on 34.87.125.241 |
| CORS | Same-origin via Caddy path routing (no CORS needed) |

---

## Project Structure

```
pact-network/
  packages/
    sdk/                    — @pact-network/monitor
      src/
        index.ts            — barrel export: pactMonitor(), types
        types.ts            — CallRecord, PactConfig, Classification, PaymentData
        wrapper.ts          — fetch wrapper, orchestrates call → extract → classify → store
        payment-extractor.ts — detect x402/MPP headers, base64 decode, extract payment fields
        classifier.ts       — classify: success / timeout / error / schema_mismatch
        storage.ts          — JSON lines file: append, read, query stats, mark synced
        sync.ts             — batch POST to backend on interval, retry logic
      package.json
      tsconfig.json

    backend/                — Fastify API + PostgreSQL
      src/
        index.ts            — server bootstrap
        db.ts               — PostgreSQL connection + query helpers
        schema.sql          — table definitions
        routes/
          records.ts        — POST /api/v1/records (batch ingest, authenticated)
          providers.ts      — GET providers, /:id, /:id/timeseries (public)
          health.ts         — GET /health
        middleware/
          auth.ts           — API key validation for write endpoints
        utils/
          insurance.ts      — rate formula + tier classification
        scripts/
          seed.ts           — generate 10K+ realistic records
          generate-key.ts   — create API keys
      Dockerfile
      package.json
      tsconfig.json

    scorecard/              — Vite + React dashboard
      src/
        main.tsx            — app entry
        App.tsx             — router: / and /provider/:id
        api/
          client.ts         — fetch from /api/v1/*
        components/
          ProviderTable.tsx  — ranked table, main page
          ProviderDetail.tsx — detail page with charts
          Charts/            — FailureTimeline, FailureBreakdown
        hooks/
          useProviders.ts   — data fetching + 30s auto-refresh
        styles/
          global.css        — design system theme
      Dockerfile
      package.json
      tsconfig.json
      vite.config.ts

  deploy/
    docker-compose.yml      — backend + postgres + scorecard + caddy
    Caddyfile               — /api/* → backend, /* → scorecard static

  docs/                     — PRD, specs
  package.json              — workspaces: ["packages/*"]
  tsconfig.base.json        — shared TS config (strict, ES2022)
  CLAUDE.md
  .gitignore
  .env.example
```

---

## Database Schema (PostgreSQL)

### Table: providers

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | TEXT | "Helius", "Jupiter", etc. |
| category | TEXT | "RPC", "Price Feed", "DEX Aggregator", "MCP Tool" |
| base_url | TEXT | hostname for matching (e.g. "api.helius.xyz") |
| wallet_address | TEXT | provider's payTo address (from x402/MPP headers) |
| created_at | TIMESTAMPTZ | auto |

### Table: call_records

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| provider_id | UUID | FK → providers.id |
| endpoint | TEXT | "/quote", "/v0/transactions", etc. |
| timestamp | TIMESTAMPTZ | when call was made (from SDK) |
| status_code | INTEGER | HTTP status: 200, 402, 500, 0 (network fail) |
| latency_ms | INTEGER | response time in ms |
| classification | TEXT | "success" \| "timeout" \| "error" \| "schema_mismatch" |
| payment_protocol | TEXT | "x402" \| "mpp" \| null (free call) |
| payment_amount | BIGINT | raw amount in smallest unit (1000000 = 1 USDC) |
| payment_asset | TEXT | token mint address |
| payment_network | TEXT | CAIP-2 format: "solana:5eykt4Us..." |
| payer_address | TEXT | agent's wallet pubkey |
| recipient_address | TEXT | provider's wallet |
| tx_hash | TEXT | on-chain tx signature (proof of payment) |
| settlement_success | BOOLEAN | did payment settle? |
| agent_id | TEXT | from API key (who submitted this record) |
| created_at | TIMESTAMPTZ | when ingested |

### Table: api_keys

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| key_hash | TEXT | SHA-256 of actual key |
| label | TEXT | "alan-test-agent", "demo-seeder" |
| created_at | TIMESTAMPTZ | auto |

### Provider Matching

SDK sends hostname + path in call records. Backend matches hostname → provider. On first ingest, if hostname is unknown, backend auto-creates the provider with category "Unknown".

---

## API Endpoints

### Write (authenticated — API key in Authorization header)

**POST /api/v1/records**

```json
{
  "records": [
    {
      "hostname": "api.helius.xyz",
      "endpoint": "/v0/transactions",
      "timestamp": "2026-04-07T10:30:00Z",
      "status_code": 200,
      "latency_ms": 145,
      "classification": "success",
      "payment_protocol": "x402",
      "payment_amount": 1000000,
      "payment_asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payment_network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "payer_address": "AgentPubkey...",
      "recipient_address": "ProviderPubkey...",
      "tx_hash": "TxSignature...",
      "settlement_success": true
    }
  ]
}
```

Response: `{ "accepted": 50, "provider_ids": ["uuid1", "uuid2"] }`

### Read (public — no auth)

**GET /api/v1/providers** — all providers ranked by insurance rate

```json
[
  {
    "id": "uuid",
    "name": "QuickNode",
    "category": "RPC",
    "total_calls": 3200,
    "failure_rate": 0.001,
    "avg_latency_ms": 89,
    "uptime": 0.999,
    "insurance_rate": 0.0025,
    "tier": "RELIABLE",
    "total_payment_amount": 1600000000,
    "lost_payment_amount": 1600000
  }
]
```

**GET /api/v1/providers/:id** — detailed stats

```json
{
  "id": "uuid",
  "name": "Jupiter",
  "category": "DEX Aggregator",
  "total_calls": 5100,
  "failure_rate": 0.015,
  "avg_latency_ms": 320,
  "p50_latency_ms": 280,
  "p95_latency_ms": 890,
  "p99_latency_ms": 1200,
  "uptime": 0.985,
  "insurance_rate": 0.0235,
  "tier": "ELEVATED",
  "failure_breakdown": { "timeout": 42, "error": 28, "schema_mismatch": 7 },
  "top_endpoints": [
    { "endpoint": "/quote", "calls": 3200, "failure_rate": 0.012 },
    { "endpoint": "/swap", "calls": 1900, "failure_rate": 0.021 }
  ],
  "payment_breakdown": {
    "x402": { "calls": 3800, "total_amount": 4200000000, "lost_amount": 63000000 },
    "mpp": { "calls": 1100, "total_amount": 890000000, "lost_amount": 12000000 },
    "free": { "calls": 200 }
  }
}
```

**GET /api/v1/providers/:id/timeseries** — `?granularity=hourly|daily&days=7`

```json
{
  "provider_id": "uuid",
  "granularity": "hourly",
  "data": [
    { "bucket": "2026-04-07T10:00:00Z", "calls": 120, "failures": 2, "failure_rate": 0.017 }
  ]
}
```

**GET /health** — `{ "status": "ok", "db": "connected" }`

---

## Insurance Rate Formula

```
insurance_rate = max(0.001, failure_rate × 1.5 + 0.001)
```

| Provider | Failure Rate | Insurance Rate | Tier |
|----------|-------------|----------------|------|
| QuickNode | 0.1% | 0.25% | RELIABLE |
| Helius | 0.3% | 0.55% | RELIABLE |
| Jupiter | 1.5% | 2.35% | ELEVATED |
| DexScreener | 2.0% | 3.10% | ELEVATED |
| CoinGecko | 3.0% | 4.60% | ELEVATED |

**Tiers:**
- RELIABLE: insurance rate < 1%
- ELEVATED: insurance rate 1%–5%
- HIGH RISK: insurance rate > 5%

Computed server-side in `backend/src/utils/insurance.ts`. Returned in API responses. Scorecard displays only.

---

## SDK Design

### Developer Experience

```typescript
import { pactMonitor } from '@pact-network/monitor'

const monitor = pactMonitor({
  apiKey: 'pact_abc123...',
  syncEnabled: true,
  syncIntervalMs: 30_000,
  latencyThresholdMs: 5_000,
})

const res = await monitor.fetch('https://api.helius.xyz/v0/transactions', options)
// res is the original Response — untouched
```

### Internal Flow

1. **Call** — `fetch(url, options)`, measure latency. If fetch throws → catch, still record.
2. **Extract Payment** — Check response headers: `PAYMENT-RESPONSE` (x402), `Payment-Receipt` (MPP). Base64 decode → extract amount, payer, recipient, tx_hash. If no headers → null.
3. **Classify** — success (2xx + fast + schema ok), timeout (slow), error (non-2xx/network), schema_mismatch (2xx but wrong body).
4. **Store** — Append CallRecord as JSON line to `~/.pact-monitor/records.jsonl`. Mark `synced: false`.
5. **Sync** — Timer every 30s. Read unsynced records, POST /api/v1/records. On success: mark synced. On failure: retry next interval. Non-blocking.
6. **Return** — Original Response. Nothing modified, nothing delayed.

### Golden Rule

If the SDK crashes, the API call must still succeed. Every step after fetch() is wrapped in try/catch. The agent's business logic is never affected by Pact Monitor.

### x402 Header Extraction

```typescript
// After fetch() completes:
const paymentResponse = response.headers.get('PAYMENT-RESPONSE')  // x402
const paymentReceipt = response.headers.get('Payment-Receipt')    // MPP

if (paymentResponse) {
  const decoded = JSON.parse(atob(paymentResponse))
  // { success, transaction, network, payer }
}
```

### Files (~460 lines total)

| File | Responsibility |
|------|---------------|
| index.ts | Barrel export |
| types.ts | CallRecord, PactConfig, Classification, PaymentData |
| wrapper.ts | Fetch wrapper, orchestrates steps 1-6 |
| payment-extractor.ts | Detect x402/MPP headers, decode, extract fields |
| classifier.ts | Classify call results |
| storage.ts | JSON lines: append, read, stats, mark synced |
| sync.ts | Batch POST, retry logic |

---

## Scorecard Design

### Pages

**Rankings ( / )** — Table of all providers ranked by insurance rate (lowest first):
- Columns: Provider, Category, Calls, Failure %, Latency, Uptime, Insurance Rate, $ at Risk, Tier
- "$ at Risk" = sum of payment_amount on failed calls (concrete dollar amounts)
- Click row → provider detail page
- Auto-refresh every 30 seconds

**Provider Detail ( /provider/:id )** — Detailed view:
- Summary stat cards: failure rate, avg latency, insurance rate, $ lost, tier
- Failure rate over time chart (Recharts line/bar chart, hourly/daily)
- Failure type breakdown (timeout vs error vs schema_mismatch)
- Top endpoints by call volume and failure rate
- Payment protocol breakdown (x402 vs MPP vs free, with dollar amounts)

### Design System

| Token | Value | Usage |
|-------|-------|-------|
| Background | #151311 | dark, warm charcoal |
| Copper | #B87333 | financial values, insurance rates, ELEVATED tier |
| Burnt Sienna | #C9553D | failures, violations, HIGH RISK tier |
| Slate | #5A6B7A | healthy states, RELIABLE tier |
| Headline font | Inria Serif | page titles, provider names |
| Body font | Inria Sans | descriptions, labels |
| Data font | JetBrains Mono | numbers, rates, percentages, code |
| Border radius | 0 or minimal | brutalist aesthetic |
| Icons | Material Symbols | consistent with landing page |

**Rules:** No emojis. No gradients. No rounded pill badges. Uppercase tracking-widest for tier badges. Border-based buttons. Dark-first theme.

### Tech

- Vite + React (SPA, static build)
- React Router (/ and /provider/:id)
- Recharts (charts, themed to design system)
- Tailwind CSS (custom theme with design tokens)
- Custom `useProviders()` hook with 30s auto-refresh polling

---

## Deployment

### Same-Origin Architecture

Single domain `pactnetwork.io`. Caddy routes by path:
- `/api/*` → Fastify backend (port 3000)
- `/health` → Fastify backend
- `/*` → Scorecard static files (SPA fallback to index.html)

No CORS needed. One DNS A record.

### Docker Compose (4 services)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    volumes: ./data/postgres:/var/lib/postgresql/data

  backend:
    build: ./packages/backend
    depends_on: postgres
    expose: 3000

  scorecard:
    build: ./packages/scorecard
    # Multi-stage: build → serve static

  caddy:
    image: caddy:2-alpine
    ports: "80:80", "443:443"
    volumes: ./deploy/Caddyfile
```

### Deploy Flow

1. SSH into 34.87.125.241
2. `git pull`
3. `docker compose up -d --build`
4. `docker compose exec backend npx tsx scripts/seed.ts`
5. Caddy auto-provisions HTTPS via Let's Encrypt
6. `pactnetwork.io` is live

---

## Data Seeding

Script generates realistic monitoring data for 5+ providers:

| Provider | Category | Failure Rate | Latency | Pattern |
|----------|----------|-------------|---------|---------|
| Helius | RPC | ~0.3% | Fast | Low, steady |
| QuickNode | RPC | ~0.1% | Moderate | Very reliable |
| Jupiter | DEX Aggregator | ~1.5% | Variable | Spikes during high volume |
| CoinGecko | Price Feed | ~3% | Moderate | Rate limiting patterns |
| DexScreener | Price Feed | ~2% | Slow | Occasional timeout bursts |

- 10,000+ total records
- Realistic time patterns: higher failures during peak hours, occasional outage windows
- Mix of x402 and MPP payment data with realistic USDC amounts
- Generates over 7 days of historical data for timeseries charts

---

## Open Questions for Rick

1. Can you share the landing page Tailwind config so scorecard uses identical color tokens?
2. DNS: single A record for pactnetwork.io → 34.87.125.241 (same-origin approach, no subdomains needed)
3. Confirm the 5 seeded providers are the right ones, or suggest alternatives

---

## What's NOT in Scope

- On-chain anything (no Solana program, no smart contracts)
- Insurance pools, underwriters, coverage, premium payments, refunds
- Payment processing (SDK monitors x402/MPP calls, doesn't handle payments)
- User self-registration or provider dashboards
- Mobile-optimized UI
- Landing page (already exists at pactnetwork.io)
