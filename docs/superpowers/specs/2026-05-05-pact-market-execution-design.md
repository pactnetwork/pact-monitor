# Pact Market V1 — Execution Design

**Status:** approved by Alan 2026-05-05
**Updated 2026-05-05** — Network/Market layering, per-endpoint pools, agent-custody-via-approval, interchangeable fee recipients (Treasury + Affiliates, pool residual).
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

### 1.5 Pact Network rails vs Pact Market interface

The codebase is split into two layers. **Every contributor must respect this rule.**

- **Pact Network = the rails.** On-chain program(s), `@pact-network/wrap` library, settler, indexer, classifier protocol, Postgres schema, shared types. Generic; consumed by any interface.
- **Pact Market = one curated interface.** The 5 provider handlers (Helius, Birdeye, Jupiter, Elfa, fal.ai), the hosted Hono proxy that uses `@pact-network/wrap` underneath, the dashboard UX, the demo allowlist, the brand surface agents call. One opinionated product on top of the rails.

**Versioning rule:** v1 (this spec, ships now) and v2 (future multi-underwriter design with third-party capital) are **both Network-layer artifacts**, not Market-layer. The on-chain crates rename to `pact-network-v1-pinocchio` (this) and `pact-network-v2-pinocchio` (the existing insurance program).

**Wrap-mechanism layering rule:** the *protocol* of wrapping a fetch call (time it, check balance, forward, classify, emit event, attach `X-Pact-*` headers) lives in Network (`@pact-network/wrap`). *Per-endpoint classifier plugins* (how a JSON-RPC response vs a REST 4xx maps to ok/breach/no-charge) live in the consuming interface — Market ships its 5 provider plugins; future BYO integrators ship their own.

**Acceptance test for the layering:** an external integrator can install `@pact-network/wrap` + `@pact-network/protocol-v1-client`, register their endpoint with their own affiliate pubkey, and start collecting insured calls — without touching any Market code. If that works, Network rails are real.

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

### 3.1 `pact-market-pinocchio` (on-chain program) — **Network rails**

A separate Pinocchio crate at `packages/program/programs-pinocchio/pact-market-pinocchio/`. Distinct from the existing `pact-insurance-pinocchio` crate; no shared state, no shared error namespace.

**Crate rename target:** `pact-network-v1-pinocchio` (Step C of refactor plan). This is Network-layer code: generic protocol primitives, no Market-specific logic. The v2 multi-underwriter program (today's `pact-insurance-pinocchio`) renames to `pact-network-v2-pinocchio` separately.

**State accounts** (per PRD §11, with extensions):

| Account | PDA seeds | Notes |
|---|---|---|
| `CoveragePool` | `[b"coverage_pool", endpoint_slug]` | **per-endpoint** (was singleton — see §3.1.1); pool authority + USDC vault |
| `EndpointConfig` | `[b"endpoint", slug]` | slug max 16 bytes; **adds `current_period_start: i64` + `current_period_refunds: u64`** for in-program hourly cap enforcement; **adds `coverage_pool: Pubkey`, `fee_recipients: [FeeRecipient; 8]`, `fee_recipient_count: u8`** (see §3.1.1, §3.1.3) |
| ~~`AgentWallet`~~ | ~~`[b"agent_wallet", owner.key()]`~~ | **Removed (see §3.1.2). Agent custody is now SPL Token approval-based; agent keeps USDC in their own ATA.** |
| `CallRecord` | `[b"call", call_id]` | 16-byte UUID; init constraint = dedup |
| `SettlementAuthority` | `[b"settlement_authority"]` | singleton; hot key V1, multisig V2; also the SPL Token *delegate* the agent approves |
| `Treasury` | `[b"treasury"]` | **NEW (§3.1.3).** Singleton USDC vault for the protocol fee. Authority = pool authority V1, multisig at mainnet flip |
| `ProtocolConfig` | `[b"protocol_config"]` | **NEW (§3.1.3).** Stores `max_total_fee_bps` + default fee recipient template |

**Instructions:**

| Instruction | Signer | Notes |
|---|---|---|
| ~~`initialize_coverage_pool`~~ | ~~pool authority~~ | **Folded into `register_endpoint` (§3.1.1).** Endpoints can no longer exist in a registered-but-unfunded state. |
| `initialize_settlement_authority(signer)` | pool authority | one-time |
| `initialize_treasury` | pool authority | **NEW (§3.1.3).** Singleton bootstrap for the protocol fee vault. |
| `initialize_protocol_config` | pool authority | **NEW (§3.1.3).** Sets `max_total_fee_bps` and default fee-recipient template. |
| `register_endpoint(slug, premium, percent_bps, sla_ms, imputed_cost, exposure_cap, fee_recipients?)` | pool authority | Now also creates the per-endpoint `CoveragePool` PDA + USDC vault atomically; accepts optional `fee_recipients` override (defaults from `ProtocolConfig`); enforces fee-recipient invariants (§3.1.3) |
| `update_endpoint_config(...)` | pool authority | optional fields |
| `update_fee_recipients(slug, fee_recipients)` | pool authority | **NEW (§3.1.3).** Atomic replace of an endpoint's fee-recipient array; same invariants enforced |
| `pause_endpoint(paused)` | pool authority | |
| ~~`initialize_agent_wallet`~~ | ~~agent~~ | **Removed (§3.1.2).** No PDA — agent uses their regular USDC ATA. |
| ~~`deposit_usdc(amount)`~~ | ~~agent~~ | **Removed (§3.1.2).** Replaced by SPL Token `Approve` to the `SettlementAuthority` delegate. |
| ~~`request_withdrawal(amount)`~~ | ~~agent~~ | **Removed (§3.1.2).** Agent always has custody — nothing to withdraw. |
| ~~`execute_withdrawal`~~ | ~~agent~~ | **Removed (§3.1.2).** |
| `top_up_coverage_pool(slug, amount)` | pool authority | Now scoped to a specific endpoint's pool |
| `settle_batch(events: Vec<SettlementEvent>)` | settlement authority | Dedup via CallRecord init. Per event: debits **agent USDC ATA → endpoint's CoveragePool** for full premium via SPL delegate authority (§3.1.2); then per fee recipient transfers **CoveragePool → recipient.destination** for `premium * bps / 10_000` (§3.1.3); on breach, transfers **CoveragePool → agent USDC ATA** for the refund. All atomic in one tx. |
| ~~`claim_refund(amount)`~~ | ~~agent~~ | **Removed (§3.1.2).** Refunds go directly to agent's USDC ATA inside `settle_batch`. No claim step. |

**Errors:** PRD §11 codes 6000-6014, plus `ArithmeticOverflow = 6015`, plus new fee-validation codes (`FeeRecipientCountExceeded`, `FeeBpsExceedsCap`, `DuplicateFeeDestination`, `MultipleTreasuryRecipients`, `SettlementDelegateRevoked`).

**Constants:**
- `MAX_BATCH_SIZE = 50` (per Rick); will benchmark on surfpool, drop to 20 if compute fails
- ~~`WITHDRAWAL_COOLDOWN_SECS = 86_400`~~ (removed — no withdrawals under agent custody)
- ~~`MAX_DEPOSIT_LAMPORTS = 25_000_000`~~ (removed — no deposit step; agent sets their own SPL approval)
- `MIN_PREMIUM_LAMPORTS = 100`
- `MAX_FEE_RECIPIENTS = 8`
- `MAX_TOTAL_FEE_BPS = 3000` (default protocol cap = 30%; prevents pool starvation)

**Security invariants** (per PRD §11): all 7 hold, plus invariant 4 (hourly exposure cap) is enforced in-program via the new fields above.

**Build target:** Pinocchio 0.10. Codama-generated TS client published as `@pact-network/protocol-v1-client` (renamed from `@pact-network/pact-market-client`).

#### 3.1.1 Per-endpoint coverage pools

The original singleton `CoveragePool` PDA `[b"coverage_pool"]` was exploitable: a correlated outage on one popular provider would drain the entire pool, leaving every other insured endpoint uncovered. Bad actors could orchestrate forced breaches on a low-risk endpoint to drain capital meant for high-risk endpoints. v1 isolates risk per endpoint before mainnet.

**Seed change:** `[b"coverage_pool"]` → `[b"coverage_pool", endpoint_slug]`. One pool per registered slug; the pool's USDC vault is its associated token account.

**`EndpointConfig.coverage_pool: Pubkey`** is added so clients/settler resolve the pool by reading EndpointConfig instead of re-deriving the PDA every call. This also gives a future escape hatch: a `coverage_pool_key: [u8; 16]` indirection can let multiple endpoint slugs aggregate under one logical pool (e.g., `helius-rpc` + `helius-das` share `helius` root). For V1 ship, default `coverage_pool_key = slug`.

**`initialize_coverage_pool` is folded into `register_endpoint`.** Registering an endpoint creates its pool + USDC vault atomically. No more registered-but-unfunded state. `top_up_coverage_pool` now takes a slug and credits only that pool.

`settle_batch` resolves each event's pool from `EndpointConfig.coverage_pool` and debits/credits each pool independently within the batch. Pool-depleted error is scoped per pool, not global. Hourly exposure cap (§ invariant 4) was already per-endpoint — no change.

#### 3.1.2 Agent custody via SPL Token approval

**Rick's call (2026-05-05):** the agent's wallet must be managed by the agent, not by Pact. The original PDA-custody design (deposit → settler debits → 24h cooldown withdrawal) was Pact-managed custody — wrong shape. v1 ships with **SPL Token approval/delegation** so the agent always holds custody.

**Model:**
- Agent keeps USDC in their own ATA at their own pubkey. Pact never holds it.
- Agent grants Pact's `SettlementAuthority` PDA a spending allowance via the standard SPL Token `Approve` instruction (one wallet click).
- Settler debits directly from the agent's USDC ATA on `settle_batch` using delegate authority. No deposit step.
- Agent can call SPL Token `Revoke` any time. Future debits then fail at the SPL Token level; the program marks the event `settlement_failed`, the rest of the batch is unaffected, and the dashboard surfaces "Approval expired — re-approve to resume insured calls".
- Refunds come from `CoveragePool` **directly to the agent's USDC ATA** inside `settle_batch`. No `claim_refund` step.

**Removed from V1 (vs the original PRD §11 design):** `AgentWallet` PDA + USDC vault, `initialize_agent_wallet`, `deposit_usdc`, `request_withdrawal`, `execute_withdrawal`, `claim_refund`, `WITHDRAWAL_COOLDOWN_SECS`, `MAX_DEPOSIT_LAMPORTS`, dashboard `RefundClaimer`. **5 instructions and 1 PDA gone**, simpler code, simpler tests, simpler UX.

**Per-agent stats live off-chain.** With no `AgentWallet` PDA, the indexer's denormalized `Agent` table aggregates from `CallRecord` PDAs (which still exist for dedup). Lifetime premiums paid, refunds received, calls covered all served from Postgres.

**`SettlementAuthority` keeps its dual role:** it is both (a) the on-chain signer for `settle_batch` and (b) the SPL Token delegate the agent approves to debit their USDC ATA.

**Approval UX (dashboard):** first time the agent connects, dashboard checks if (a) their USDC ATA exists, and (b) `SettlementAuthority` has an active approval. If not, prompts: "Approve $25 spending allowance for Pact to insure your API calls" — one wallet click. When the allowance is exhausted, banner prompts a one-click top-up. "Stop insurance" button calls SPL Token `Revoke` directly.

#### 3.1.3 Premium collection + interchangeable fee recipients

**Rick's call (2026-05-05):** premium collection must be enforced on-chain with most of the premium going to the pool and percentages going to other parties — and the recipient list must be **interchangeable**, not hardcoded. V1 ships a generic recipients model; v2 can add new kinds (Underwriter, Oracle, Governance) without contract churn.

**Routing rule.** Agent-to-network funding is **agent USDC ATA → CoveragePool** for the *full premium*, period. Fee shares are paid out **from the pool** to each recipient in the same atomic `settle_batch` instruction. The pool is the single accounting hub: gross premium-in is always the pool's debit, every fee outflow has the pool as its source.

**Pool is the residual, NOT a slot in the recipients array.** Whatever isn't paid out as a fee stays in the pool by virtue of not being moved. Fee recipients are an interchangeable list of zero or more entries; each has a kind, destination, and bps share *of the premium*.

**On-chain shape:**

```rust
#[repr(u8)]
pub enum FeeRecipientKind {
    Treasury     = 0, // singleton Pact protocol fee; destination = Treasury PDA's USDC vault
    AffiliateAta = 1, // affiliate / integrator USDC ATA (raw pubkey)
    AffiliatePda = 2, // affiliate USDC vault owned by a PDA (e.g., a multisig)
    // future: Oracle, Governance, Referrer, Underwriter — add new kinds only if
    // transfer semantics differ; most parties can use AffiliateAta / AffiliatePda.
}

#[repr(C)]
pub struct FeeRecipient {
    pub kind: u8,            // FeeRecipientKind
    pub destination: Pubkey, // 32 bytes; semantics depend on kind
    pub bps: u16,            // share in basis points, off the premium
    pub _pad: [u8; 5],       // align to 40 bytes
}

pub struct EndpointConfig {
    // ... existing fields plus the §3.1.1 coverage_pool ...
    pub fee_recipient_count: u8,
    pub _pad: [u8; 7],
    pub fee_recipients: [FeeRecipient; 8], // first `fee_recipient_count` valid
}

pub struct ProtocolConfig {
    pub max_total_fee_bps: u16,            // protocol cap, default 3000 (30%)
    pub default_fee_recipient_count: u8,
    pub _pad: [u8; 5],
    pub default_fee_recipients: [FeeRecipient; 8],
}
```

**Validation invariants** (enforced on `register_endpoint` and `update_fee_recipients`):
- `fee_recipient_count <= MAX_FEE_RECIPIENTS` (8)
- `sum(fee.bps) <= 10_000` (100%)
- `sum(fee.bps) <= MAX_TOTAL_FEE_BPS` (default 3000 = 30%; prevents pool starvation)
- `Treasury` kind appears at most once
- No two recipients with the same `destination`
- For `AffiliateAta`, `destination` must be a valid USDC ATA at registration time (mint check)
- For `Treasury`, `destination` must equal the Treasury PDA's USDC vault (resolved at runtime)

Fixed-size array of 8 (not Vec) — Pinocchio has no allocator and 8 × 40 bytes = 320 bytes per endpoint is comfortable. Today's needs (Treasury + 0-N Affiliates) and near-future (+ Oracle + Referrer + Governance) leave slots free.

**V1 fee parties: Treasury (always) + zero or more Affiliates (optional).** No external underwriters in V1 — Pact funds the coverage pool itself. v2 adds an Underwriter recipient kind.

**Default V1 fee templates:**

| Template | Kinds | Total fees | Pool retains |
|---|---|---|---|
| Pact Market endpoints (default for all 5 launch endpoints) | `[Treasury 10%, Affiliate 5%]` (Affiliate = Pact Market's USDC ATA) | 15% | 85% |
| BYO integrator with their own affiliate | `[Treasury 10%, Affiliate X%]` | 10% + X% | residual |
| No-affiliate (raw protocol use) | `[Treasury 10%]` | 10% | 90% |

Rick can override the protocol-level defaults via `initialize_protocol_config`. Any endpoint can override at `register_endpoint` time or via `update_fee_recipients` afterward (subject to `MAX_TOTAL_FEE_BPS`).

**`settle_batch` per-event flow** (channel-then-fan-out):
1. Transfer **agent USDC ATA → endpoint's CoveragePool vault** for the full premium, signed by `SettlementAuthority` PDA via SPL delegate authority (§3.1.2).
2. For each `FeeRecipient` in the endpoint's array: transfer **CoveragePool vault → recipient.destination** for `premium * recipient.bps / 10_000`. CoveragePool authority signs (program PDA).
3. On breach: transfer **CoveragePool vault → agent USDC ATA** for the refund amount. No fee recipients touched on refund.

**Rounding rule:** fee shares use rounded-down bps math; the pool absorbs the rounding remainder. Bias toward pool capital adequacy.

**Min-premium guard:** unchanged — `MIN_PREMIUM_LAMPORTS = 100`. Validator warns at register time if any fee `bps < (10_000 / MIN_PREMIUM_LAMPORTS)` because that share would round to zero on minimum-premium calls.

**Account-list growth in `settle_batch`:** per unique endpoint in a batch, +CoveragePool PDA + USDC vault. Per unique fee-recipient destination across the batch (deduplicated), +1 account. Per unique agent in a batch, +agent USDC ATA (mutable; debit source under SPL delegate authority). Worst case V1 (5 endpoints, default `[Treasury 10%, Affiliate 5%]`, single Market integrator): ~15 accounts beyond per-event agent ATA / CallRecord / EndpointConfig. Surfpool benchmark before Friday confirms compute budget at `MAX_BATCH_SIZE = 50` with the channel-then-fan-out flow.

### 3.2 `pact-proxy` (Cloud Run, Hono, Node 22) — **Market interface**

Package rename target: `@pact-network/market-proxy`. Consumes the new `@pact-network/wrap` library (Network rails) for the generic fetch-call lifecycle; ships only the Market-specific bits (the 5 provider classifier plugins, force-breach demo mode + DemoAllowlist, public-domain wiring for `market.pactnetwork.io`).

Receives `/v1/{slug}/...`, forwards to upstream, measures latency, classifies outcome, publishes event to Pub/Sub, returns response with `X-Pact-*` headers.

**Routes:**
- `GET /health` — liveness
- `GET /v1/agents/:pubkey` — read-only agent insurable-state snapshot (USDC ATA balance + SPL `delegated_amount` allowance, §3.1.2)
- `ALL /v1/:slug/*` — proxy handler
- `POST /admin/reload-endpoints` — bearer-token gated; clears in-memory caches

**Internals:**
- `EndpointRegistry` — loads endpoints + demo_allowlist + operator_allowlist from Postgres on cold start; refreshes every 60s or on `/admin/reload-endpoints`. **(Market-specific)**
- Calls `wrapFetch()` from `@pact-network/wrap` (Network rails) per request. Wrap handles balance check (reads agent's USDC ATA balance + delegated allowance via SPL Token RPC — see §3.1.2 — replacing the old `AgentWallet.balance` lookup), timer, forward, classify, emit event.
- Provides per-provider `Classifier` plugins (`classifiers/helius.ts`, `birdeye.ts`, `jupiter.ts`, `elfa.ts`, `falai.ts`) that implement the wrap library's `Classifier` interface. **(Market-specific.)**
- Configures wrap's `EventSink` as `PubSubEventSink` for the Cloud Run deployment.
- `ForceBreach` — if `query.demo_breach === "1"` AND wallet in `DemoAllowlist`, sleep `sla_latency_ms + 300ms` before forwarding upstream. **(Market-specific.)**

**Environment:** `RPC_URL`, `PG_URL`, `PUBSUB_PROJECT`, `PUBSUB_TOPIC`, `ENDPOINTS_RELOAD_TOKEN`. Service account auth for Pub/Sub via Cloud Run workload identity.

### 3.3 `pact-settler` (Cloud Run, NestJS, Node 22, min-instances=1) — **Network rails**

Generic; pulls events from a Network-defined sink and signs `settle_batch`. No Market-specific logic. Pulls events from Pub/Sub, batches up to 50 events / 5s, builds + signs `settle_batch`, submits to devnet, on success POSTs batch summary to indexer.

**Modules:**
- `ConsumerService` — Pub/Sub pull subscriber; in-memory queue.
- `BatcherService` — 5s timer + max-size flush; produces `SettleBatch` job.
- `SubmitterService` — builds `settle_batch` ix via Codama TS client, signs with key from Secret Manager, sends with retry (3x exp backoff). On success → ack Pub/Sub messages. On 3rd failure → no-ack (will redeliver) + log + alert.
- `IndexerPusher` — `POST /events` to indexer with batch summary + per-event records; bearer-token shared secret.

**Endpoints:**
- `GET /health` — reports `lag_ms` since last successful batch
- `GET /metrics` — Prometheus (batch_size, batch_duration, queue_lag, tx_failures)

**Note on refunds:** under §3.1.2's agent-custody model, refunds land directly in the agent's USDC ATA inside `settle_batch` itself. Settler does not need to fire any `claim_refund` instruction (it's been removed from the program). Dashboard does not need a `RefundClaimer` hook.

**Per-pool / per-recipient account-list builder:** settler groups batch events by `endpoint_slug`, derives per-endpoint pool PDAs (§3.1.1), and deduplicates fee-recipient destinations across the batch (§3.1.3). Each endpoint's CoveragePool vault appears as `mutable` (destination of premium-in AND source of fee payouts AND source of refunds within the same tx). Settler does not compute the split itself — the program reads each EndpointConfig's fee_recipients array on-chain and does the channel-then-fan-out.

**Environment:** `PUBSUB_PROJECT`, `PUBSUB_SUBSCRIPTION`, `SOLANA_RPC_URL`, `SETTLEMENT_AUTHORITY_KEY` (mounted from Secret Manager), `PROGRAM_ID`, `INDEXER_URL`, `INDEXER_PUSH_SECRET`, `LOG_LEVEL`.

### 3.4 `pact-indexer` (Cloud Run, NestJS, Node 22) — **Network rails**

Generic; stores Network primitives (per-call records, per-endpoint pool state, per-agent denormalized stats, per-recipient earnings). Receives event pushes from settler, writes Postgres rows. Serves dashboard read API.

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

### 3.5 `pact-dashboard` (Vercel, Next.js 15 App Router) — **Market interface**

Package rename target: `@pact-network/market-dashboard`. Human-facing surface for Pact Market specifically — branded Market UX, Market endpoint catalog, demo flow. Public read-only views + wallet-connect approval flow.

**Routes (Wed scope):**
- `/` Overview — hero stats aggregated across per-endpoint pools (§3.1.1) + Treasury earned + top affiliate earnings; event stream from indexer
- `/endpoints` — table from `/api/endpoints` (5s cache); columns include per-endpoint pool balance + current fee-recipient split
- `/agents/[pubkey]` — connected agent's history. **No auto-claim** — refunds land directly in the agent's USDC ATA at settle time (§3.1.2).

**Routes (Thu/Fri scope):** `/agents`, `/endpoints/[slug]`, `/calls/[id]`, `/ops`, `/?demo=1` driver.js tour.

**Internals:**
- `useAgentInsurableState` hook (replaces `useAgentWallet`) — reads agent's USDC ATA balance + `delegated_amount` (allowance remaining) via SPL Token RPC every 5s; exposes `{ ataBalance, allowance, eligible }`.
- ~~`RefundClaimer`~~ — **removed** (§3.1.2). No client-side claim flow; refunds appear directly in the agent's wallet.
- Approval/Re-approve/Revoke buttons — call SPL Token `Approve` / `Revoke` directly via wallet adapter.
- `WalletConnect` — `@solana/wallet-adapter-react` (Phantom, Solflare, Backpack).
- "Get devnet USDC" button — Next.js API route. Calls Solana's built-in `requestAirdrop` for 1 SOL. For devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), we do not own the mint authority; instead, the button links the user to Circle's public devnet USDC faucet (https://faucet.circle.com) and the dashboard polls until the user's ATA shows a positive balance, then unlocks the deposit step. **Whole "Get devnet USDC" flow is removed before mainnet flip.**

**Environment:** `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_SOLANA_RPC`, `NEXT_PUBLIC_PROXY_URL`, `NEXT_PUBLIC_INDEXER_URL`. No server-side faucet key needed — devnet USDC sourced via Circle's public faucet, not our own mint.

### 3.6 `@pact-network/wrap` (TS library, NEW) — **Network rails**

Generic fetch-call wrap library. Any interface (Market today, BYO SDKs tomorrow, x402 facilitators, future Pact integrators) consumes this to insure any fetch call. Lives in `packages/wrap/`.

**`wrapFetch(opts)`** — the request lifecycle: timer start → balance check → forward → timer end → classify → emit event → attach `X-Pact-*` response headers → return upstream response. One function call replaces the proxy's hand-rolled lifecycle.

**Pluggable interfaces** (consumers wire their own implementations):
- `BalanceCheck` — input: agent pubkey + endpoint config; output: `{ eligible, ataBalance, allowance }`. Default impl reads agent's USDC ATA balance + SPL Token `delegated_amount` via Solana RPC with LRU cache (§3.1.2 model).
- `Classifier` — input: upstream response + latency + endpoint config; output: `{ premium, refund, breach, reason }`. Wrap ships the abstract type and a "default classifier" (latency vs `sla_latency_ms`, 5xx → breach, 429 → no-charge, network-error → server_error). **Per-endpoint classifier plugins live in the consuming interface, not in wrap.** Market ships its 5 provider plugins; future BYO integrators ship their own.
- `EventSink` — pluggable: `PubSubEventSink` (Market default), `HttpEventSink` (for SDK consumers POSTing to a Network settlement endpoint), `MemoryEventSink` (testing). Settler doesn't care which sink the producer used as long as the message conforms to `SettlementEvent`.

**Header constants:** `X-Pact-Premium`, `X-Pact-Refund`, `X-Pact-Latency-Ms`, `X-Pact-Outcome`, `X-Pact-Pool`, `X-Pact-Settlement-Pending`.

**`SettlementEvent` schema** also exported from `@pact-network/shared`.

**Acceptance** — an external integrator wires their own SDK:

```ts
import { wrapFetch, HttpEventSink } from '@pact-network/wrap';
import { defaultClassifier } from '@pact-network/wrap/classifiers';

const sink = new HttpEventSink({ url: 'https://settler.pactnetwork.io/events', secret: '...' });
const response = await wrapFetch({
  endpointSlug: 'their-api',
  walletPubkey: agentWallet,
  upstreamUrl: 'https://their-api.com/v1/whatever',
  init: { method: 'POST', body },
  classifier: defaultClassifier,
  sink,
});
```

If this works against a network where their endpoint is registered with their own affiliate pubkey, Network rails are real.

---

## 4. Data flow

### 4.1 Successful insured call (no breach)

1. Agent: `GET market.pactnetwork.io/v1/helius/?api-key=KEY&pact_wallet=PUBKEY`
2. Proxy: lookup endpoint config (in-memory cache, 60s TTL)
3. Proxy (via `wrapFetch` BalanceCheck, §3.6): read agent's USDC ATA balance + SPL Token `delegated_amount` (LRU cache 30s; on miss, RPC)
4. Proxy: `min(ataBalance, allowance) >= flat_premium`? if no, 402
5. Proxy: `t_start = Date.now()`
6. Proxy: forward to upstream
7. Proxy: `t_end = Date.now()` (first byte received)
8. Proxy: classify → `{premium: 500, refund: 0, breach: false}`
9. Proxy: publish SettlementEvent to Pub/Sub
10. Proxy: response with `X-Pact-*` headers + upstream body

Async (1-5s):
11. Settler: pulls batch
12. Settler: builds `settle_batch(events)` ix with per-pool + per-fee-recipient accounts (§3.1.1, §3.1.3)
13. Settler: signs + submits
14. Solana: settle_batch executes — for each event, init CallRecord, transfer premium **agent USDC ATA → endpoint's CoveragePool vault** (via SPL delegate authority, §3.1.2), then per fee_recipient transfer **CoveragePool → recipient.destination** for `premium * bps / 10_000` (§3.1.3); pool retains the residual; increment counters
15. Settler: ack Pub/Sub
16. Settler: POST batch summary to indexer
17. Indexer: idempotent upsert into `calls` + `agents` + `endpoints` + per-endpoint `pool_state` + per-recipient `settlement_recipient_share`
18. Dashboard (next 5s poll): SELECT new rows, re-render

### 4.2 SLA breach (latency > sla OR upstream 5xx)

Same as 4.1 through step 7. Then:
- Step 8': classify → `{premium: 500, refund: 1000, breach: true, reason: "latency"|"5xx"}`
- Step 14': `settle_batch` transfers premium **agent USDC ATA → CoveragePool**, fans out fees **CoveragePool → recipients**, AND refund **CoveragePool → agent USDC ATA** — all atomic in the same ix per event.

Dashboard side: refund is already in the agent's wallet by the time the next poll runs. No `claim_refund` step. Dashboard just re-reads the agent's USDC ATA balance and shows the updated number.

### 4.3 Force-breach demo

Same as 4.1 through step 4. Then:
- Step 5*: `query.demo_breach === "1"` AND wallet ∈ `DemoAllowlist`?
- Step 6*: if yes, `await sleep(endpoint.sla_latency_ms + 300)`
- Continue from step 5 onward; latency now exceeds SLA → 4.2 applies.

### 4.4 Agent approval (replaces "deposit") — §3.1.2 model

1. Dashboard: user clicks "Approve $25 spending allowance for Pact"
2. Dashboard: builds standard SPL Token `Approve` ix — `approve(agent_usdc_ata, settlement_authority_pda, 25_000_000)`. No protocol-side instruction; this is a vanilla SPL Token call.
3. Wallet adapter signs, submits, confirms
4. Dashboard re-reads agent's USDC ATA via SPL Token RPC, shows updated `delegated_amount` allowance and confirms `eligible: true`

To stop insurance: dashboard "Stop insurance" button → SPL Token `Revoke` → no protocol cooldown, takes effect on the next settle.

---

## 5. State stores

| Store | Source of truth for | Read by | Write by |
|---|---|---|---|
| Solana devnet program accounts | Pact-controlled money state (per-endpoint CoveragePool, EndpointConfig, CallRecord, SettlementAuthority, Treasury, ProtocolConfig — see §3.1) | Settler, Dashboard, Indexer | Settler, Pool authority |
| Agent's own USDC ATA + SPL `delegated_amount` | Agent's USDC + approval for SettlementAuthority delegate (§3.1.2) | Proxy/wrap, Dashboard, Settler | Agent (Approve/Revoke), SPL Token program (debits during settle_batch) |
| Cloud SQL Postgres | Per-call history, allowlists, denormalized stats (per-endpoint pool state, per-recipient earnings — §3.1.3) | Indexer, Proxy (registry+allowlist on cold load) | Indexer, manual seed scripts |
| Pub/Sub | Transient event queue | Settler | Proxy (via wrap's `PubSubEventSink`) |
| Cloud Run in-memory caches | Endpoint registry (60s), wallet balance + allowance (30s) | Proxy | Proxy on miss |
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

// Per-agent stats now live entirely off-chain (§3.1.2 — no AgentWallet PDA).
// Indexer aggregates from CallRecord on each settle.
model Agent {
  pubkey                String   @id @db.VarChar(44)
  // walletPda removed — no PDA in V1
  displayName           String?
  // totalDepositsLamports removed — no deposit step
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
  shares                SettlementRecipientShare[]
}

// Per-recipient breakdown for §3.1.3 fee fan-out.
// One row per (settlement, recipient destination).
model SettlementRecipientShare {
  id              String     @id @default(cuid())
  settlementSig   String
  recipientKind   Int        // FeeRecipientKind enum
  recipientPubkey String     @db.VarChar(44)
  amountLamports  BigInt
  settlement      Settlement @relation(fields: [settlementSig], references: [signature])

  @@index([recipientPubkey])
  @@index([settlementSig])
}

model RecipientEarnings {
  recipientPubkey        String   @id @db.VarChar(44)
  recipientKind          Int
  lifetimeEarnedLamports BigInt
  lastUpdated            DateTime
}

// Per-endpoint pool state — was singleton (id=1), now keyed by slug (§3.1.1).
model PoolState {
  endpointSlug           String   @id @db.VarChar(16)
  currentBalanceLamports BigInt
  totalPremiumsLamports  BigInt
  totalRefundsLamports   BigInt
  totalFeesPaidLamports  BigInt   @default(0)
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
| Pool depleted (per-endpoint, §3.1.1) | settle_batch returns `PoolDepleted` for that endpoint's pool | Settler skips refund for that event only; other endpoints' pools unaffected; alert; pool authority tops up the depleted pool |
| Agent SPL approval revoked / insufficient (§3.1.2) | SPL Token Transfer fails inside settle_batch | Program marks event `settlement_failed`, continues batch; settler acks Pub/Sub for the failed event; indexer flags it; dashboard surfaces "Approval expired — re-approve to resume insured calls" |
| Cloud SQL down | indexer reads/writes throw | Dashboard falls back to RPC for headline totals; per-call history stale until DB recovers |

---

## 7. Testing

### 7.1 Per unit

| Unit | Framework | Coverage |
|---|---|---|
| pact-market-pinocchio (→ pact-network-v1-pinocchio) | LiteSVM (Bun) for unit; surfpool for integration; Codama TS client in tests | Every instruction has happy + at least one negative test. settle_batch dedicated cases: batch-size, dedup, exposure-cap, premium/refund math, paused-endpoint, unauthorized-signer. **Plus: per-endpoint pool isolation (§3.1.1) — each pool debited/credited correctly across mixed-endpoint batches; pool-depleted scoped per pool. Plus: SPL approval flow (§3.1.2) — happy delegate path, revoked-approval marks event `settlement_failed`, refund lands in agent ATA. Plus: fee fan-out (§3.1.3) — default `[Treasury 10%, Affiliate 5%]` template, no-affiliate, multi-affiliate, rounding goes to pool, validation rejects (sum > MAX_TOTAL_FEE_BPS, duplicate destination, multiple Treasury, AffiliateAta with wrong mint), pool-as-source for fee payouts.** |
| pact-proxy | Vitest. Mock Pub/Sub + fetch | Each route, each endpoint handler, each error path, rate limit, force-breach, balance cache hit/miss |
| pact-settler | Vitest + @nestjs/testing. Mock Pub/Sub, RPC, indexer | Batcher splits at MAX_BATCH_SIZE. Idempotency on retry. Tx build matches Codama. Failure → no-ack |
| pact-indexer | Vitest + @nestjs/testing + testcontainers Postgres | Idempotent /events upsert. Operator signed-message verification. Stats cache |
| pact-dashboard | Vitest for hooks; Playwright e2e (Thu) | `useAgentInsurableState` hook (ATA balance + allowance read), Approve/Revoke flow, per-pool stats render. Wed: smoke-test by hand |

### 7.2 Integration: scripts/e2e-devnet.sh

Built Wed PM. Script:
1. Use existing devnet program deploy (or fresh deploy if first run)
2. `initialize_treasury` + `initialize_protocol_config` (one-time bootstrap)
3. `register_endpoint` for helius, birdeye, jupiter (each creates its own CoveragePool atomically — §3.1.1; default `[Treasury 10%, Affiliate 5%]` template — §3.1.3)
4. Test keypair: ensure USDC ATA exists; SPL Token `Approve(settlement_authority_pda, 5_000_000)` (§3.1.2)
5. Make 3 calls through deployed proxy URL — assert X-Pact-* headers + Pub/Sub event published
6. Wait 6s, assert settler picked up, assert tx confirmed
7. Assert indexer Postgres has 3 `calls` rows + per-endpoint `PoolState` updated + `SettlementRecipientShare` rows for Treasury and Affiliate
8. Force-breach call — assert refund lands in test keypair's USDC ATA directly (no claim step)
9. SPL Token `Revoke` from test keypair — next call's settle marks event `settlement_failed`, agent ATA untouched
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
Connect Phantom (devnet), get devnet USDC, **approve $25 SPL spending allowance to `SettlementAuthority`** (§3.1.2), 5 insured calls, force-breach 2, watch refunds appear directly in Phantom's USDC balance (no auto-claim step). Iterate on rough spots.

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
| ~~Refund claim auto-fire fires too aggressively (signs every 5s)~~ | ~~LOW~~ | **Removed** — refunds now land directly in agent's USDC ATA inside `settle_batch` (§3.1.2). No auto-claim flow. |
| Agent revokes SPL approval mid-session, breaks insured calls silently | MEDIUM | Dashboard banner on `delegated_amount == 0`; settle_batch marks event `settlement_failed` and rest of batch unaffected (§3.1.2); indexer surfaces failure rate per agent |
| Per-endpoint pool refactor adds account-list overhead in settle_batch | MEDIUM | Surfpool benchmark Wed AM at MAX_BATCH_SIZE=50 with channel-then-fan-out flow (§3.1.3); drop batch size if compute fails |
| Treasury single-key liability | MEDIUM | V1 ships with treasury authority = pool authority (acceptable for $200 seed pool). Pre-mainnet checklist: rotate to multisig before flip |
