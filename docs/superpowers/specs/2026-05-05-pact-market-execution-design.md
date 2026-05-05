# Pact Market V1 — Execution Design

**Status:** approved by Alan 2026-05-05
**Owner:** Alan (eng), Rick (product)
**Target ship:** May 11, 2026 (Colosseum submission)
**Wed gate:** May 6, 2026 — public devnet end-to-end, 3 endpoints, dashboard, demoed to Rick
**Mainnet flip:** May 9-10, 2026

This spec governs the end-to-end build of Pact Market V1. It supersedes Rick's PRD where they conflict (Rick said "don't follow PRD 100%, focus on features"). Open product questions still defer to Rick.

---

## 1. Scope and decisions

### 1.1 Wed May 6 deliverable
Public devnet end-to-end, shareable link `dashboard.pactnetwork.io`:
- 3 insured endpoints: Helius RPC, Birdeye API, Jupiter Quote API
- Live `/`, `/endpoints`, `/agents/[pubkey]` views
- Wallet adapter (Phantom/Solflare/Backpack); "Get devnet USDC" airdrop button
- Force-breach demo mode (`?demo_breach=1`, gated to Postgres `demo_allowlist`)
- Settler running, refunds auto-claim while wallet connected

### 1.2 Friday May 8 deliverable
- 4th + 5th endpoint (Elfa, fal.ai)
- Pact CLI (`pact run` + `pact balance | deposit | refunds | history` + SKILL.md integration)
- Driver.js Colosseum tour
- Operator console (`/ops`)
- Telegram alert webhook
- Backfill admin endpoint for indexer
- Pre-mainnet checklist (PRD §20) executed

### 1.3 May 11 ship
- Mainnet program deployed, $200 USDC pool seed
- All 5 endpoints registered on mainnet
- `dashboard.pactnetwork.io`, `market.pactnetwork.io`, `indexer.pactnetwork.io` live
- SKILL.md `solder-build/pact-market-skill` published
- Colosseum submission

### 1.4 Out of V1
- Multi-region proxy
- Co-signed call records
- Third-party underwriter pool
- Availability/schema SLAs (PRD §1.1)
- AI API endpoints (OpenAI, Anthropic — PRD V2)
- Cross-chain (PRD V3)

---

## 2. Architecture

```
[Agent / Browser]
   |
   HTTPS
   v
[Cloud Run: pact-proxy (Hono, Node 22)]                    [Cloud Pub/Sub]
   |                                          publish ----> topic: pact-settle-events
   |                                                        |
   |--HTTPS--> [Helius / Birdeye / Jupiter]                 | pull subscription
                                                            v
                                            [Cloud Run: pact-settler (NestJS, min=1)]
                                              |
                                              |--sendTransaction--> [Solana devnet]
                                              |                       pact-market-pinocchio program
                                              |
                                              |--HTTPS--> [Cloud Run: pact-indexer (NestJS)]
                                                            |
                                                            v
                                                         [Cloud SQL Postgres]
                                                            ^
                                                            |
                                              [Vercel: Next.js dashboard] -- RPC reads --> [Solana devnet]
                                                            ^
                                                            |
                                                         [Browser]
```

### 2.1 Trust boundaries
- Proxy → Pub/Sub: best-effort. Lost events = lost premium revenue, agent unaffected.
- Settler → program: trusted via settlement_authority signer (hot key in GCP Secret Manager).
- Settler → indexer: best-effort HTTP. On failure, dashboard falls back to RPC reads for headline totals.
- Dashboard → RPC: read-only public state.
- Operator endpoints: signed-message auth verified against Postgres `operator_allowlist`.

### 2.2 Service boundaries
Five independent units, each owns one concern. Settler doesn't read Postgres; indexer doesn't talk to Solana except for ops unsigned-tx building; proxy doesn't talk to indexer except registry+allowlist load. Failures don't cascade.

---

## 3. Components

### 3.1 `pact-market-pinocchio` (on-chain program)

A separate Pinocchio crate at `packages/program/programs-pinocchio/pact-market-pinocchio/`. Distinct from the existing `pact-insurance-pinocchio` crate; no shared state, no shared error namespace.

**State accounts** (per PRD §11, with extensions):

| Account | PDA seeds | Notes |
|---|---|---|
| `CoveragePool` | `[b"coverage_pool"]` | singleton; pool authority + USDC vault |
| `EndpointConfig` | `[b"endpoint", slug]` | slug max 16 bytes; **adds `current_period_start: i64` + `current_period_refunds: u64`** for in-program hourly cap enforcement |
| `AgentWallet` | `[b"agent_wallet", owner.key()]` | per-agent prepaid balance + 24h withdrawal cooldown |
| `CallRecord` | `[b"call", call_id]` | 16-byte UUID; init constraint = dedup |
| `SettlementAuthority` | `[b"settlement_authority"]` | singleton; hot key V1, multisig V2 |

**Instructions:**

| Instruction | Signer | Notes |
|---|---|---|
| `initialize_coverage_pool` | pool authority | one-time |
| `initialize_settlement_authority(signer)` | pool authority | one-time |
| `register_endpoint(slug, premium, percent_bps, sla_ms, imputed_cost, exposure_cap)` | pool authority | |
| `update_endpoint_config(...)` | pool authority | optional fields |
| `pause_endpoint(paused)` | pool authority | |
| `initialize_agent_wallet` | agent | |
| `deposit_usdc(amount)` | agent | max $25/wallet (PRD §11 constants) |
| `request_withdrawal(amount)` | agent | starts 24h cooldown |
| `execute_withdrawal` | agent | after cooldown |
| `top_up_coverage_pool(amount)` | pool authority | |
| `settle_batch(events: Vec<SettlementEvent>)` | settlement authority | dedup via CallRecord init; debits AgentWallet → CoveragePool; if breach, credits CoveragePool → AgentWallet |
| **`claim_refund(amount)`** | agent | **NEW (not in PRD §11)**; transfers AgentWallet vault → owner ATA |

**Errors:** PRD §11 codes 6000-6014, plus new `ArithmeticOverflow = 6015` (resolves PRD §11 inconsistency).

**Constants:**
- `MAX_BATCH_SIZE = 50` (per Rick); will benchmark on surfpool, drop to 20 if compute fails
- `WITHDRAWAL_COOLDOWN_SECS = 86_400`
- `MAX_DEPOSIT_LAMPORTS = 25_000_000`
- `MIN_PREMIUM_LAMPORTS = 100`

**Security invariants** (per PRD §11): all 7 hold, plus invariant 4 (hourly exposure cap) is enforced in-program via the new fields above.

**Build target:** Pinocchio 0.10. Codama-generated TS client published as `@pact-network/pact-market-client` (or absorbed into `@pact-network/shared`).

### 3.2 `pact-proxy` (Cloud Run, Hono, Node 22)

Receives `/v1/{slug}/...`, forwards to upstream, measures latency, classifies outcome, publishes event to Pub/Sub, returns response with `X-Pact-*` headers.

**Routes:**
- `GET /health` — liveness
- `GET /v1/agents/:pubkey` — read-only AgentWallet snapshot
- `ALL /v1/:slug/*` — proxy handler
- `POST /admin/reload-endpoints` — bearer-token gated; clears in-memory caches

**Internals:**
- `EndpointRegistry` — loads endpoints + demo_allowlist + operator_allowlist from Postgres on cold start; refreshes every 60s or on `/admin/reload-endpoints`.
- `BalanceCache` — `Map<wallet, {balance, expires}>`; 30s TTL; reads `AgentWallet.balance` field via RPC `getAccountInfo`.
- `Timer` — `Date.now()` t_start / first-byte / t_end; latency = t_end - t_start.
- `Classifier` — input: upstream response + latency + endpoint config; output: `{premium, refund, breach, reason}`. Per-endpoint logic in `endpoints/{helius,birdeye,jupiter}.ts`.
- `EventPublisher` — fire-and-forget `@google-cloud/pubsub` publish.
- `ForceBreach` — if `query.demo_breach === "1"` AND wallet in `DemoAllowlist`, sleep `sla_latency_ms + 300ms` before forwarding upstream.

**Environment:** `RPC_URL`, `PG_URL`, `PUBSUB_PROJECT`, `PUBSUB_TOPIC`, `ENDPOINTS_RELOAD_TOKEN`. Service account auth for Pub/Sub via Cloud Run workload identity.

### 3.3 `pact-settler` (Cloud Run, NestJS, Node 22, min-instances=1)

Pulls events from Pub/Sub, batches up to 50 events / 5s, builds + signs `settle_batch`, submits to devnet, on success POSTs batch summary to indexer.

**Modules:**
- `ConsumerService` — Pub/Sub pull subscriber; in-memory queue.
- `BatcherService` — 5s timer + max-size flush; produces `SettleBatch` job.
- `SubmitterService` — builds `settle_batch` ix via Codama TS client, signs with key from Secret Manager, sends with retry (3x exp backoff). On success → ack Pub/Sub messages. On 3rd failure → no-ack (will redeliver) + log + alert.
- `IndexerPusher` — `POST /events` to indexer with batch summary + per-event records; bearer-token shared secret.

**Endpoints:**
- `GET /health` — reports `lag_ms` since last successful batch
- `GET /metrics` — Prometheus (batch_size, batch_duration, queue_lag, tx_failures)

**Note on claim_refund:** settler does NOT auto-fire `claim_refund` (it doesn't have agent's signing key). Dashboard auto-claims while wallet is connected (see 3.5). Headless agents use Pact CLI's `pact claim`.

**Environment:** `PUBSUB_PROJECT`, `PUBSUB_SUBSCRIPTION`, `SOLANA_RPC_URL`, `SETTLEMENT_AUTHORITY_KEY` (mounted from Secret Manager), `PROGRAM_ID`, `INDEXER_URL`, `INDEXER_PUSH_SECRET`, `LOG_LEVEL`.

### 3.4 `pact-indexer` (Cloud Run, NestJS, Node 22)

Receives event pushes from settler, writes Postgres rows. Serves dashboard read API.

**Routes:**
- `POST /events` — bearer-token gated; idempotent upsert by `call_id`
- `GET /health`
- `GET /api/stats` — 5s in-memory cache
- `GET /api/endpoints`, `/api/endpoints/:slug`
- `GET /api/agents/:pubkey`, `/api/agents/:pubkey/calls?limit=N`
- `GET /api/calls/:id`
- `POST /api/ops/{pause,update-config,topup}` — operator allowlist gated; verifies signed message; builds unsigned tx; returns to dashboard for wallet to sign
- `POST /admin/backfill` — Thu/Fri pre-mainnet addition; replays `getSignaturesForAddress(programId)` since timestamp

**Internals:**
- `WebhookController` — idempotency check (call_id PK conflict = skip), Prisma upsert.
- `StatsService` — 5s cache.
- `OpsService` — verifies `nacl.sign.detached.verify(message, signature, allowlistedPubkey)`, builds unsigned txs via Codama.

**Environment:** `PG_URL`, `INDEXER_PUSH_SECRET`, `SOLANA_RPC_URL`, `PROGRAM_ID`.

### 3.5 `pact-dashboard` (Vercel, Next.js 15 App Router)

Public read-only views + wallet-connect demo flow + auto-claim refunds.

**Routes (Wed scope):**
- `/` Overview — hero stats from RPC (CoveragePool live read), event stream from indexer
- `/endpoints` — table from `/api/endpoints` (5s cache)
- `/agents/[pubkey]` — connected agent's history; `RefundClaimer` auto-fires `claim_refund` when `pendingRefund > 0`

**Routes (Thu/Fri scope):** `/agents`, `/endpoints/[slug]`, `/calls/[id]`, `/ops`, `/?demo=1` driver.js tour.

**Internals:**
- `useAgentWallet` hook — reads AgentWallet PDA via RPC every 5s; exposes `balance`, `pendingRefund`, `pendingWithdrawal`, `withdrawalUnlockAt`.
- `RefundClaimer` — subscribes to `useAgentWallet`; when `pendingRefund > 0`, builds + signs `claim_refund` via wallet adapter, submits, refreshes.
- `WalletConnect` — `@solana/wallet-adapter-react` (Phantom, Solflare, Backpack).
- "Get devnet USDC" button — Next.js API route. Calls Solana's built-in `requestAirdrop` for 1 SOL. For devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), we do not own the mint authority; instead, the button links the user to Circle's public devnet USDC faucet (https://faucet.circle.com) and the dashboard polls until the user's ATA shows a positive balance, then unlocks the deposit step. **Whole "Get devnet USDC" flow is removed before mainnet flip.**

**Environment:** `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_SOLANA_RPC`, `NEXT_PUBLIC_PROXY_URL`, `NEXT_PUBLIC_INDEXER_URL`. No server-side faucet key needed — devnet USDC sourced via Circle's public faucet, not our own mint.

---

## 4. Data flow

### 4.1 Successful insured call (no breach)

1. Agent: `GET market.pactnetwork.io/v1/helius/?api-key=KEY&pact_wallet=PUBKEY`
2. Proxy: lookup endpoint config (in-memory cache, 60s TTL)
3. Proxy: `getBalance(PUBKEY)` (LRU cache 30s; on miss, RPC `getAccountInfo`)
4. Proxy: balance >= flat_premium? if no, 402
5. Proxy: `t_start = Date.now()`
6. Proxy: forward to upstream
7. Proxy: `t_end = Date.now()` (first byte received)
8. Proxy: classify → `{premium: 500, refund: 0, breach: false}`
9. Proxy: publish SettlementEvent to Pub/Sub
10. Proxy: response with `X-Pact-*` headers + upstream body

Async (1-5s):
11. Settler: pulls batch
12. Settler: builds `settle_batch(events)` ix
13. Settler: signs + submits
14. Solana: settle_batch executes — for each event, init CallRecord, transfer premium AgentWallet vault → CoveragePool vault, increment counters
15. Settler: ack Pub/Sub
16. Settler: POST batch summary to indexer
17. Indexer: idempotent upsert into `calls` + `agents` + `endpoints` + `pool_state`
18. Dashboard (next 5s poll): SELECT new rows, re-render

### 4.2 SLA breach (latency > sla OR upstream 5xx)

Same as 4.1 through step 7. Then:
- Step 8': classify → `{premium: 500, refund: 1000, breach: true, reason: "latency"|"5xx"}`
- Step 14': settle_batch transfers premium AgentWallet→CoveragePool AND refund CoveragePool→AgentWallet vault in same ix per event

Dashboard side:
- 19'. RefundClaimer (running while wallet connected): polls AgentWallet PDA every 5s, sees pendingRefund > 0
- 20'. Dashboard: builds `claim_refund(amount)` ix
- 21'. Wallet adapter signs (Phantom popup or silent if pre-approved), submits, confirms
- 22'. Solana: `claim_refund` transfers AgentWallet vault → owner ATA
- 23'. Dashboard re-reads, balance updated

### 4.3 Force-breach demo

Same as 4.1 through step 4. Then:
- Step 5*: `query.demo_breach === "1"` AND wallet ∈ `DemoAllowlist`?
- Step 6*: if yes, `await sleep(endpoint.sla_latency_ms + 300)`
- Continue from step 5 onward; latency now exceeds SLA → 4.2 applies.

### 4.4 Agent deposit

1. Dashboard: user clicks "Deposit 5 USDC"
2. Dashboard: builds `deposit_usdc(5_000_000)` ix client-side via Codama TS client (no indexer round-trip; deposits don't need allowlist verification)
3. Wallet adapter signs, submits, confirms
4. Dashboard re-reads AgentWallet PDA (RPC), shows new balance

---

## 5. State stores

| Store | Source of truth for | Read by | Write by |
|---|---|---|---|
| Solana devnet program accounts | All money state (CoveragePool, EndpointConfig, AgentWallet, CallRecord, SettlementAuthority) | Settler, Dashboard, Indexer | Settler, Agent, Pool authority |
| Cloud SQL Postgres | Per-call history, allowlists, denormalized stats | Indexer, Proxy (registry+allowlist on cold load) | Indexer, manual seed scripts |
| Pub/Sub | Transient event queue | Settler | Proxy |
| Cloud Run in-memory caches | Endpoint registry (60s), wallet balance (30s) | Proxy | Proxy on miss |
| Browser localStorage | Wallet adapter session | Dashboard | Wallet adapter |

### 5.1 Postgres schema (Prisma)

```prisma
model Endpoint {
  slug                       String   @id @db.VarChar(16)
  flatPremiumLamports        BigInt
  percentBps                 Int
  slaLatencyMs               Int
  imputedCostLamports        BigInt
  exposureCapPerHourLamports BigInt
  paused                     Boolean  @default(false)
  upstreamBase               String
  displayName                String
  logoUrl                    String?
  registeredAt               DateTime
  lastUpdated                DateTime
  calls                      Call[]
}

model Agent {
  pubkey                String   @id @db.VarChar(44)
  walletPda             String   @db.VarChar(44)
  displayName           String?
  totalDepositsLamports BigInt   @default(0)
  totalPremiumsLamports BigInt   @default(0)
  totalRefundsLamports  BigInt   @default(0)
  callCount             BigInt   @default(0)
  lastCallAt            DateTime?
  createdAt             DateTime
  calls                 Call[]
}

model Call {
  callId          String   @id @db.VarChar(36)
  agentPubkey     String   @db.VarChar(44)
  endpointSlug    String   @db.VarChar(16)
  premiumLamports BigInt
  refundLamports  BigInt
  latencyMs       Int
  breach          Boolean
  breachReason    String?  @db.VarChar(16)
  source          String?  @db.VarChar(32)
  ts              DateTime
  settledAt       DateTime
  signature       String   @db.VarChar(88)

  agent    Agent    @relation(fields: [agentPubkey], references: [pubkey])
  endpoint Endpoint @relation(fields: [endpointSlug], references: [slug])

  @@index([agentPubkey, ts(sort: Desc)])
  @@index([endpointSlug, ts(sort: Desc)])
  @@index([ts(sort: Desc)])
  @@index([breach, ts(sort: Desc)])
}

model Settlement {
  signature             String   @id @db.VarChar(88)
  batchSize             Int
  totalPremiumsLamports BigInt
  totalRefundsLamports  BigInt
  ts                    DateTime
}

model PoolState {
  id                     Int      @id @default(1)
  currentBalanceLamports BigInt
  totalDepositsLamports  BigInt
  totalPremiumsLamports  BigInt
  totalRefundsLamports   BigInt
  lastUpdated            DateTime
}

model DemoAllowlist {
  walletPubkey String   @id @db.VarChar(44)
  addedAt      DateTime @default(now())
  note         String?
}

model OperatorAllowlist {
  walletPubkey String   @id @db.VarChar(44)
  addedAt      DateTime @default(now())
  note         String?
}
```

V1 uses plain SQL views or indexer-side aggregation with 5s cache instead of materialized views (PRD §14). Materialized views with `CONCURRENTLY` refresh are post-Colosseum.

---

## 6. Error handling

| Failure | Detection | Mitigation |
|---|---|---|
| Pub/Sub publish fails (proxy) | publish promise rejects | Log error, return upstream response anyway; lost premium revenue, agent unaffected |
| Settler down | Pub/Sub messages accumulate, no ack | Cloud Run min-instances=1; health-check restart; messages remain in subscription |
| Solana tx fails | sendTransaction throws | 3x exp backoff; on 3rd failure, log+alert+no-ack (redeliver) |
| Duplicate call_id | settle_batch returns "account already in use" | Settler treats as success, acks |
| Indexer push fails | HTTP error | 3x retry; on persistent failure, log+alert; dashboard falls back to RPC reads for headline totals |
| Pool depleted | settle_batch returns `PoolDepleted` | Settler skips refund for that event; alert; Rick tops up pool |
| Cloud SQL down | indexer reads/writes throw | Dashboard falls back to RPC for headline totals; per-call history stale until DB recovers |

---

## 7. Testing

### 7.1 Per unit

| Unit | Framework | Coverage |
|---|---|---|
| pact-market-pinocchio | LiteSVM (Bun) for unit; surfpool for integration; Codama TS client in tests | Every instruction has happy + at least one negative test. settle_batch dedicated cases: batch-size, dedup, exposure-cap, premium/refund math, paused-endpoint, unauthorized-signer |
| pact-proxy | Vitest. Mock Pub/Sub + fetch | Each route, each endpoint handler, each error path, rate limit, force-breach, balance cache hit/miss |
| pact-settler | Vitest + @nestjs/testing. Mock Pub/Sub, RPC, indexer | Batcher splits at MAX_BATCH_SIZE. Idempotency on retry. Tx build matches Codama. Failure → no-ack |
| pact-indexer | Vitest + @nestjs/testing + testcontainers Postgres | Idempotent /events upsert. Operator signed-message verification. Stats cache |
| pact-dashboard | Vitest for hooks; Playwright e2e (Thu) | useAgentWallet, RefundClaimer logic. Wed: smoke-test by hand |

### 7.2 Integration: scripts/e2e-devnet.sh

Built Wed PM. Script:
1. Use existing devnet program deploy (or fresh deploy if first run)
2. `register_endpoint` for helius, birdeye, jupiter
3. `initialize_agent_wallet` for test keypair
4. `deposit_usdc(5_000_000)`
5. Make 3 calls through deployed proxy URL — assert X-Pact-* headers + Pub/Sub event published
6. Wait 6s, assert settler picked up, assert tx confirmed
7. Assert indexer Postgres has 3 `calls` rows
8. Force-breach call — assert refund credited to AgentWallet
9. `claim_refund` from test keypair — assert USDC lands in owner ATA
10. Re-run script — assert idempotent, no duplicate CallRecord

Pre-Wed-demo gate: this script must pass twice in a row.

---

## 8. Deployment plan

### 8.1 Tue night May 5
- Captain: finalize spec, generate implementation plan via writing-plans skill, fan out 5 crew on independent worktrees.
- Rick: respond to PR #48 + #49 re-review; set up GCP project (or grant access); enable Cloud Run + Cloud SQL + Cloud DNS + Pub/Sub + Secret Manager APIs; hand Alan a service account key.

### 8.2 Wed AM May 6 (00:00 → 12:00)
Five parallel crews complete their unit:
- Crew 1 (program): cargo build → LiteSVM tests passing → deploy to devnet → Codama IDL pushed to `packages/shared/src/version.ts`
- Crew 2 (proxy): Cloud Run deployed at `pact-proxy-<hash>.run.app`
- Crew 3 (settler): Cloud Run deployed at `pact-settler-<hash>.run.app` with min-instances=1
- Crew 4 (indexer): Cloud SQL migrations applied, Cloud Run deployed
- Crew 5 (dashboard): Vercel preview deploy

### 8.3 Wed PM May 6 (12:00 → 18:00) — Captain integration
- DNS: `market.pactnetwork.io` → proxy, `indexer.pactnetwork.io` → indexer, `dashboard.pactnetwork.io` → Vercel
- `scripts/seed-endpoints.ts` registers 3 endpoints
- `scripts/seed-allowlists.ts` adds Rick's wallet to demo + operator allowlists
- `scripts/e2e-devnet.sh` must pass twice
- Top up CoveragePool with 1000 devnet USDC

### 8.4 Wed evening May 6 (18:00 → 23:00) — Rick walkthrough
Connect Phantom (devnet), get devnet USDC, deposit to AgentWallet, 5 insured calls, force-breach 2, watch refunds auto-claim. Iterate on rough spots.

### 8.5 Thu May 7
- Driver.js Colosseum tour
- `/agents` leaderboard + `/endpoints/[slug]` detail (PRD §15 completeness)
- 4th endpoint
- Backfill admin endpoint
- Pact CLI scaffold + `pact balance` + `pact deposit`

### 8.6 Fri May 8
- Pact CLI complete (`pact run`, SKILL.md hooks, full feature list)
- 5th endpoint
- Operator console UI (`/ops`)
- Telegram alert webhook (settler lag, pool depletion, 5xx rate)

### 8.7 Sat-Sun May 9-10
- Pre-mainnet checklist (PRD §20)
- Generate fresh mainnet keypairs (settlement_authority + pool_authority); Secret Manager
- Deploy program to mainnet
- Configure mainnet endpoint registry
- Seed pool with $200 mainnet USDC
- Smoke test on mainnet

### 8.8 Mon May 11
- Colosseum submission
- Public launch

### 8.9 Rollback
- Cloud Run: `gcloud run services update-traffic --to-revisions=<prev>=100`. ~30s cutover.
- Program: devnet redeploys are cheap; mainnet upgrade authority retained until V1.1 freeze.

---

## 9. Drop ladder (if Wed slips)

In order of authorized scope cuts:
1. Drop endpoints from 3 to 1 (Helius only)
2. Replace wallet adapter with burner wallet (browser-generated keypair)
3. Drop `/agents/[pubkey]` page
4. **Never drop:** force-breach demo mode (it's the magic moment)
5. **Never drop:** on-chain settlement (it's the entire pitch)

---

## 10. Open product questions deferred to Rick

- Helius ToS: proxying user-supplied keys — pre-mainnet legal blocker
- Legal opinion vendor for "prepaid utility credits" framing — pre-mainnet
- Mainnet pool authority and settlement authority key custody — pre-mainnet
- Operator allowlist seed (which pubkeys?)
- Demo allowlist seed (judges + Rick + Alan + ?)
- Elfa AI endpoint shape (paths, auth) — Thu
- fal.ai 1% premium confirmation — Thu

---

## 11. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| settle_batch compute budget at MAX_BATCH_SIZE=50 | HIGH | Surfpool benchmark Wed AM; drop to 20 if needed; in spec already (§3.1 constants) |
| Cloud Run cold start adds latency | MEDIUM | min-instances=1 on proxy + settler |
| Pub/Sub setup eats half-day | MEDIUM | Pre-build IaC in scripts/; document in 8.2 |
| Wallet adapter UX blocks devnet flow | MEDIUM | Drop ladder step 2: fall back to burner |
| GCP project setup blocked on Rick | HIGH | Captain sets up personal GCP project tonight as fallback if Rick's not ready by Tue 23:00 |
| Secret Manager workload identity misconfigured | MEDIUM | Test in Wed AM crew, alert captain at first deploy |
| Indexer Prisma migration fails on Cloud SQL | LOW | Test migration locally + on staging Cloud SQL Tue night |
| Refund claim auto-fire fires too aggressively (signs every 5s) | LOW | Debounce: only fire if pendingRefund unchanged for 2 polls (10s) |
