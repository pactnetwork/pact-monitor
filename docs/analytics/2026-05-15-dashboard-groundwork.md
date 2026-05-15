# Analytics Dashboard — Groundwork

Status: research draft, awaiting Rick's metric spec.
Branch: `feat/analytics-dashboard-groundwork` (off `origin/develop`).
Date: 2026-05-15.

This doc surveys every data field Pact Network already emits — through the
indexer (Postgres) and through the on-chain program (Solana account state and
instruction discriminators) — and proposes a candidate metric inventory plus a
dashboard architecture. Pure analysis; no code changes. Rick will eventually
specify exact metrics; this draft is the groundwork so we can move fast once
he does.

## Existing data

### Indexer database (Postgres, `@pact-network/db`)

Source: `packages/db/prisma/schema.prisma`.

| Table | Field | Type | Notes |
|-------|-------|------|-------|
| `Endpoint` | `slug` | varchar(16) PK | Logical endpoint name (e.g. `helius`, `birdeye`). |
| `Endpoint` | `flatPremiumLamports` | BigInt | Per-call flat premium in USDC base units. |
| `Endpoint` | `percentBps` | Int | Variable premium in bps of upstream cost. |
| `Endpoint` | `slaLatencyMs` | Int | Latency SLA threshold. |
| `Endpoint` | `imputedCostLamports` | BigInt | Refund amount on breach. |
| `Endpoint` | `exposureCapPerHourLamports` | BigInt | Hourly refund cap. |
| `Endpoint` | `paused` | Boolean | Endpoint kill switch. |
| `Endpoint` | `upstreamBase` | String | Upstream URL. |
| `Endpoint` | `displayName`, `logoUrl` | String | Cosmetic. |
| `Endpoint` | `registeredAt`, `lastUpdated` | DateTime | |
| `Agent` | `pubkey` | varchar(44) PK | Agent owner pubkey. |
| `Agent` | `totalPremiumsLamports` | BigInt | Lifetime gross premiums charged. |
| `Agent` | `totalRefundsLamports` | BigInt | Lifetime refunds received. |
| `Agent` | `callCount` | BigInt | Lifetime call count. |
| `Agent` | `lastCallAt`, `createdAt` | DateTime | |
| `Call` | `callId` | varchar(36) PK | UUID, dedupe key. |
| `Call` | `agentPubkey`, `endpointSlug` | FK | |
| `Call` | `premiumLamports`, `refundLamports` | BigInt | This-call values (refund=0 if no breach). |
| `Call` | `latencyMs` | Int | Observed upstream latency. |
| `Call` | `breach` | Boolean | Covered SLA breach (latency / 5xx / network error). |
| `Call` | `breachReason` | varchar(16) | `latency_breach`, `server_error`, `network_error`, `client_error`. |
| `Call` | `source` | varchar(32) | Origin tag — wrap library / proxy / pay.sh. |
| `Call` | `payee`, `resource` | varchar(44) / String | pay.sh-covered calls only. |
| `Call` | `ts`, `settledAt` | DateTime | Wall-clock + settlement timestamps. |
| `Call` | `signature` | varchar(88) | On-chain settle_batch tx sig. |
| `Settlement` | `signature` | varchar(88) PK | Batch tx signature. |
| `Settlement` | `batchSize` | Int | Calls in this batch. |
| `Settlement` | `totalPremiumsLamports`, `totalRefundsLamports` | BigInt | Batch totals. |
| `Settlement` | `ts` | DateTime | |
| `SettlementRecipientShare` | `recipientKind` | Int | `0`=Treasury, `1`=AffiliateAta, `2`=AffiliatePda. |
| `SettlementRecipientShare` | `recipientPubkey` | varchar(44) | ATA / vault credited. |
| `SettlementRecipientShare` | `amountLamports` | BigInt | This-batch fee outflow to this recipient. Batch-level only — not per-call. |
| `PoolState` | `endpointSlug` | varchar(16) PK | One row per coverage pool. |
| `PoolState` | `currentBalanceLamports` | BigInt | Live pool balance. |
| `PoolState` | `totalDepositsLamports` | BigInt | Lifetime deposits (top-ups). |
| `PoolState` | `totalPremiumsLamports` | BigInt | Gross in, pre-fee. |
| `PoolState` | `totalFeesPaidLamports` | BigInt | Lifetime fee outflows. |
| `PoolState` | `totalRefundsLamports` | BigInt | Lifetime refunds out. |
| `PoolState` | `lastUpdated` | DateTime | |
| `RecipientEarnings` | `recipientPubkey` | varchar(44) PK | Per-recipient leaderboard row. |
| `RecipientEarnings` | `recipientKind` | Int | See above. |
| `RecipientEarnings` | `lifetimeEarnedLamports` | BigInt | Lifetime cumulative earnings. |
| `RecipientEarnings` | `lastUpdated` | DateTime | |
| `DemoAllowlist`, `OperatorAllowlist` | `walletPubkey` | varchar(44) PK | Access lists; not analytics. |

Indices already exist on `Call(agentPubkey, ts desc)`, `Call(endpointSlug, ts desc)`, `Call(ts desc)`, `Call(breach, ts desc)`, so time-windowed queries against the raw `Call` table are cheap.

### Indexer read APIs

Source: `packages/indexer/src/{stats,api,events,ops}`.

| Route | Returns | Backing data |
|-------|---------|--------------|
| `GET /api/stats` | `totalPools`, `totalCoverageLamports`, `totalPremiumsCollected`, `totalRefundsPaid`, `totalTreasuryEarned`, `topIntegrators[10]`, plus legacy: `totalCalls`, `totalBreaches`, `breachRateBps`, `poolBalanceLamports`, `totalDepositsLamports`, `endpointCount`, `agentCount`. 5s cache. | `Call` aggregate, `PoolState` aggregate, `RecipientEarnings`. |
| `GET /api/endpoints` | List of `Endpoint` rows with joined `PoolState`. `feeRecipients: []` is TODO. | `Endpoint`, `PoolState`. |
| `GET /api/endpoints/:slug` | Single endpoint w/ pool. | `Endpoint`, `PoolState`. |
| `GET /api/agents/:pubkey` | Agent insurable snapshot. | `Agent`. |
| `GET /api/agents/:pubkey/calls?limit=N` | Recent calls for one agent, default 50, max 200. | `Call`. |
| `GET /api/calls?limit=N` | Global recent-calls firehose, default 50, max 200. | `Call`. |
| `GET /api/calls/:id` | Single call + batch-level `recipientShares`. | `Call`, `SettlementRecipientShare`. |
| `POST /events` | Ingest from settler (bearer gated). Not analytics; data source. | — |
| `POST /api/ops/{pause,update-config,topup,update-fee-recipients}` | Operator-allowlist gated; returns unsigned tx. | — |

### Market-dashboard surfaces already wired

Source: `packages/market-dashboard/app/`.

| Page | Renders |
|------|---------|
| `/` | Pool balance aggregate, treasury earned, total premiums, total refunds, calls insured, active endpoints, recent-calls table. |
| `/endpoints` | Endpoint list w/ pool health. |
| `/agents/[pubkey]` | Agent detail + recent calls. |
| `/calls/[id]` | Call detail + batch settlement breakdown. |
| `/ops` | Operator-only pause / config / topup / fee-recipients UI. |

`packages/market-dashboard/MOCK_API.md` documents the wire shape — same as the indexer's responses with one addition: live agent `balance + allowance` is read directly via Solana RPC using `getAgentInsurableState` from `@pact-network/protocol-v1-client`, not through the indexer.

### On-chain program (Pinocchio v1 at `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`)

Source: `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/`.

The Pinocchio program emits **no `msg!` / `log_data` / event lines**. All
analytics-relevant data is in two places:

1. **Instruction discriminators**, visible on every tx as the first byte of
   the ix data. Useful for `SELECT COUNT(*) GROUP BY discriminator`.

| Discriminator | Name | Frequency signal |
|---------------|------|------------------|
| 1 | InitializeSettlementAuthority | one-shot |
| 2 | RegisterEndpoint | onboard event |
| 3 | UpdateEndpointConfig | ops change |
| 4 | PauseEndpoint | ops change |
| 9 | TopUpCoveragePool | LP / treasury inflow |
| 10 | SettleBatch | **main volume signal** |
| 12 | InitializeProtocolConfig | one-shot |
| 13 | InitializeTreasury | one-shot |
| 14 | UpdateFeeRecipients | ops change |
| 15 | PauseProtocol | kill switch |

2. **PDA account state**, readable on any Solana RPC. Account discriminators
   are implicit via PDA seed prefix (e.g. `b"coverage_pool"`, `b"endpoint"`,
   `b"call"`).

| PDA | Seed | Fields useful for analytics |
|-----|------|------------------------------|
| `CoveragePool` | `[b"coverage_pool", slug]` | `total_deposits`, `total_premiums`, `total_refunds`, `current_balance`, `created_at`. |
| `EndpointConfig` | `[b"endpoint", slug]` | `paused`, `flat_premium_lamports`, `percent_bps`, `sla_latency_ms`, `imputed_cost_lamports`, `exposure_cap_per_hour_lamports`, `current_period_start`, `current_period_refunds`, `total_calls`, `total_breaches`, `total_premiums`, `total_refunds`, `last_updated`, `fee_recipients[8]` (kind/destination/bps). |
| `CallRecord` | `[b"call", call_id]` | `breach`, `settlement_status` (`Settled`/`DelegateFailed`/`PoolDepleted`/`ExposureCapClamped`), `agent`, `endpoint_slug`, `premium_lamports`, `refund_lamports`, `actual_refund_lamports`, `latency_ms`, `timestamp`. |
| `ProtocolConfig` | `[b"protocol_config"]` | Global `paused` (kill switch state). |
| `SettlementAuthority` | `[b"settlement_authority"]` | Signer; not analytics. |
| `Treasury` | `[b"treasury"]` | Treasury ATA / vault. |

The richest on-chain analytics signal is actually the **SPL Token transfers
inside every `settle_batch` tx** — Dune already indexes these. Each batch
emits:

- 1 transfer `agent_ata → pool_vault` per call (premium, authority = SettlementAuthority PDA).
- 0..8 transfers `pool_vault → fee_recipient_ata` per call (fee fan-out).
- 0..1 transfer `pool_vault → agent_ata` per call (refund on breach).

Decoded by `(authority, source, destination, mint=USDC)` this gives a fully
public, real-time view of gross premium flow, treasury cut, affiliate cut,
and refund payouts — without trusting any off-chain indexer.

### Known gaps in existing data

1. **No time-series rollups.** Every chart over time has to scan raw `Call`. Fine at current volume; needs a daily/hourly rollup table when call count crosses ~1M.
2. **No per-call recipient shares.** `SettlementRecipientShare` is batch-level (per FIX-4 decision). Per-call attribution charts (e.g. "earnings by affiliate per call") can't be built from indexer data without re-deriving from `Call.premium * EndpointConfig.fee_recipients[i].bps`.
3. **No `settlement_status` mirror.** On-chain `CallRecord.settlement_status` distinguishes `DelegateFailed` / `PoolDepleted` / `ExposureCapClamped`, but the indexer's `Call` row only stores `breach + breachReason`. Pool-depleted events are currently invisible to the dashboard.
4. **EndpointConfig.fee_recipients not synced.** `endpoints.controller.ts` returns `feeRecipients: []` with a TODO; the on-chain array is read by the proxy but not stored in Postgres.
5. **No operational lag metrics.** Settler queue depth, indexer ingest lag (`now() - dto.ts`), classifier outcome distribution per source — none of these are persisted.
6. **No classifier accuracy signal.** If wrap misclassifies `client_error` as `server_error`, the only trace is a non-zero premium with `breachReason='client_error'` (per `events.dto.ts`). Rate is not surfaced anywhere.
7. **No deposit / top-up history.** `PoolState.totalDepositsLamports` is a running total; the underlying `TopUpCoveragePool` events are not landed as rows.

## Candidate metrics

Organized by user persona. "Already queryable" means the indexer Postgres can serve it today without schema changes. "Sketch" gives Prisma or SQL pseudocode.

### Agents (API consumers)

| Metric | Definition | Source | Already queryable? | Sketch |
|--------|------------|--------|--------------------|--------|
| Calls made (lifetime / windowed) | Count of `Call` rows for an agent | indexer `Call` | yes | `prisma.call.count({ where: { agentPubkey, ts: { gte: from } } })` |
| Premiums paid | Sum of `premiumLamports` | indexer `Call` | yes | `_sum.premiumLamports` |
| Refunds received | Sum of `refundLamports` | indexer `Call` | yes | `_sum.refundLamports` |
| Net spend | Premiums − Refunds | indexer `Call` | yes | derived |
| SLA breach rate | `breach=true / total` over window | indexer `Call` (idx on `breach, ts`) | yes | aggregate |
| Top endpoints by calls | `GROUP BY endpointSlug` over `Call` | indexer `Call` | yes | groupBy |
| Latency p50 / p95 / p99 per endpoint | Percentiles of `Call.latencyMs` | indexer `Call` | yes (raw SQL) | `percentile_cont(0.95)` |
| Pool-depleted / clamped exposure | Count where on-chain `settlement_status != Settled` | on-chain `CallRecord` | **no** — needs ingest gap #3 | requires settler to forward `settlement_status` |
| First/last seen | `Agent.createdAt`, `Agent.lastCallAt` | indexer `Agent` | yes | — |

### Integrators (endpoint owners / affiliates)

| Metric | Definition | Source | Already queryable? | Sketch |
|--------|------------|--------|--------------------|--------|
| Revenue earned (lifetime) | `RecipientEarnings.lifetimeEarnedLamports` | indexer | yes | direct |
| Revenue earned (windowed) | Sum of `SettlementRecipientShare.amountLamports` joined to `Settlement.ts` | indexer | yes | join + filter |
| Calls served on endpoint | `Call.count where endpointSlug` | indexer | yes | count |
| Refund rate per endpoint | `breach / total` per slug | indexer | yes | groupBy |
| Pool health (balance, days of runway) | `PoolState.currentBalanceLamports / (avg daily refunds)` | indexer | yes | derived |
| Top agents on my endpoint | `GROUP BY agentPubkey WHERE endpointSlug` | indexer | yes | groupBy + take 10 |
| Fee split actually applied | `feeRecipients[].bps` from on-chain `EndpointConfig` | on-chain or backfill | **no** — see gap #4 | sync to DB |
| Hourly exposure utilization | `EndpointConfig.current_period_refunds / exposure_cap_per_hour_lamports` | on-chain `EndpointConfig` | **no** | poll RPC or sync |

### Treasury / protocol

| Metric | Definition | Source | Already queryable? | Sketch |
|--------|------------|--------|--------------------|--------|
| Total volume (gross premiums) | `PoolState.totalPremiumsLamports` sum | indexer | yes | already in `/api/stats` |
| Total fee outflows (any kind) | `PoolState.totalFeesPaidLamports` sum | indexer | yes | sum |
| Treasury cut | `RecipientEarnings WHERE recipientKind=0` sum | indexer | yes | already in `/api/stats.totalTreasuryEarned` |
| Pool TVL (aggregate) | `PoolState.currentBalanceLamports` sum | indexer | yes | already in `/api/stats.totalCoverageLamports` |
| Top integrators leaderboard | `RecipientEarnings` rank desc, kind ≠ 0 | indexer | yes | already in `/api/stats.topIntegrators` (top 10) |
| Top agents leaderboard | `Agent` rank by `totalPremiumsLamports` desc | indexer | yes | orderBy + take 10 |
| Endpoint mix (calls per slug) | `Call.count GROUP BY endpointSlug` | indexer | yes | groupBy |
| Refund payout ratio (refunds / premiums) | derived | indexer | yes | division |
| Net protocol margin | premiums − refunds − affiliate fees | indexer | yes | algebra over `/api/stats` |
| Daily / hourly volume time-series | `Call` grouped by `date_trunc('hour', ts)` | indexer | yes (raw SQL) | groupBy + bucket |
| Deposits (top-up history) | `TopUpCoveragePool` tx history | on-chain or settler | **no** — see gap #7 | needs ingest |

### Operations

| Metric | Definition | Source | Already queryable? | Sketch |
|--------|------------|--------|--------------------|--------|
| Settle batch frequency | `Settlement.count` per hour | indexer | yes | groupBy |
| Avg batch size | `avg(Settlement.batchSize)` | indexer | yes | aggregate |
| Indexer ingest lag | `now() − max(Call.settledAt)` | indexer | yes (live) | scalar |
| Settler → indexer end-to-end lag | `Call.settledAt − Call.ts` (median) | indexer | yes | percentile |
| Classifier outcome distribution | `count GROUP BY breachReason` | indexer | yes | groupBy |
| Failed-settle (delegate failure) rate | `settlement_status=DelegateFailed / total` | on-chain `CallRecord` | **no** — gap #3 | needs settler forward |
| Pool depletion incidents | `settlement_status=PoolDepleted` count | on-chain `CallRecord` | **no** — gap #3 | needs settler forward |
| Endpoint pause events | `UpdateEndpointConfig` / `PauseEndpoint` tx history | on-chain | partial — `Endpoint.paused` snapshot only; no history | Dune or settler log |
| Protocol-wide pause incidents | `PauseProtocol` tx history | on-chain `ProtocolConfig.paused` | **no** | Dune or settler log |
| Operator action audit log | `/api/ops/*` POSTs + `signerPubkey` | indexer (would need new table) | **no** | new ingest |

## Architecture proposal

Three options. Recommend **(B)** with one caveat.

### (A) Single Next.js panel inside `market-dashboard`

A new tab (e.g. `/analytics` or `/admin/analytics`) renders everything off the
indexer's read APIs plus a few direct `getAccountInfo` reads for the on-chain
state PDAs.

**Pros:** one codebase, reuses the design system, reuses the existing `lib/api`
wire layer, can be gated behind a wallet allowlist (the `OperatorAllowlist`
table already exists) so internal-only is trivial.

**Cons:** every chart load hits Postgres. Time-series charts on raw `Call`
will get slow when call count crosses ~1M. We'd own an ETL backlog (rollup
tables, materialized views) before that. We also lose the public-credibility
angle of a third-party-indexed view.

### (B) Dune + internal Next.js panel (recommended)

Split by audience and trust:

- **Dune dashboard** (public, marketing-grade): everything derivable from
  Solana on-chain state — SPL Token transfers initiated by the program /
  SettlementAuthority PDA, settle_batch instruction counts, top-up history,
  fee fan-out flows. Public link on the marketing site. No off-chain trust
  required; auditors / partners can verify volume claims themselves.

- **Internal Next.js panel** inside `market-dashboard` (gated, operational):
  indexer-only metrics — classifier outcome distribution, ingest lag, source
  breakdown, p95 latency, agent leaderboards, operator audit log. Wallet-
  gated via the existing `OperatorAllowlist`. Lives at `/admin/analytics`
  initially; we can promote a subset to public later by copying tiles to the
  homepage.

**Pros:** Dune does the heavy time-series lifting for free and gives us a
public-verifiable rails view (high-leverage for a protocol whose pitch is
"on-chain risk layer"). Internal panel stays small and operational. Aligns
with Rick's Dune mention.

**Cons:** Dune queries take engineering time to write + maintain; schema
changes (e.g. new ix discriminators) require Dune-side updates. Two surfaces
to keep in sync. Some metrics (e.g. classifier accuracy, source attribution
for pay.sh) are NOT on-chain — they can only live in the internal panel.

### (C) Standalone analytics service (BigQuery / Metabase / Grafana)

Pipe Postgres + on-chain events into a separate analytics warehouse, render
via Metabase or Grafana.

**Pros:** Best for ad-hoc SQL exploration; cheapest to extend post-launch.

**Cons:** Adds a service to operate; over-engineered for the current scope.
Worth revisiting after PMF.

### Recommendation

Go with **(B)**. Two delivery slices that can run in parallel once Rick
answers the questions below:

1. **Dune slice** — one dashboard with: total volume, premium flow, treasury
   cut, top integrators, top-up history, settle_batch frequency, refund
   payout ratio. All from SPL Token transfers + ix discriminators. Public.

2. **Internal panel slice** — new `/admin/analytics` route in
   `market-dashboard`, wallet-gated via `OperatorAllowlist`. Reuses existing
   indexer read APIs; adds two new endpoints we will need anyway: a
   time-series rollup (`GET /api/analytics/timeseries?bucket=hour|day`) and
   an ops summary (`GET /api/analytics/ops` — ingest lag, classifier mix,
   failed-settle counts once gap #3 is closed).

Caveat: a few of the highest-value metrics (pool-depleted incidents,
classifier accuracy) require closing indexer gaps #3 and #4 before either
surface can show them. Worth scoping into the same slice as the panel.

## Questions for Rick

Tight list — these are the load-bearing decisions:

1. **Target audience.** Is this analytics dashboard primarily for (a) the
   public / Colosseum judges / partners — marketing-grade transparency, or
   (b) us internally — operations + product, or (c) integrators — affiliate
   self-service revenue view? The answer determines public-vs-gated and how
   much we lean on Dune.

2. **Must-have metrics for V1.** From the candidate list above (Agents,
   Integrators, Treasury/Protocol, Ops), which 8-12 are the V1 cut you'd
   ship Monday? Everything else slips to V2. Treasury cut, total volume,
   top integrators, breach rate are the obvious table stakes — what else?

3. **Public vs internal.** If we go with the Dune + internal-panel split,
   which metrics are public-facing (Dune) and which stay gated (internal)?
   Treasury revenue, affiliate payouts, and per-agent spend are the
   sensitive ones — public or not?

4. **Time horizon.** Lifetime totals are cheap; rolling 24h / 7d / 30d
   windows need a rollup strategy. Is "lifetime + last 24h" enough for V1,
   or do you need full historical time-series charts (hourly granularity,
   90-day retention) from day one?
