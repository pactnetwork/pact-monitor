# Plan: Network/Market layering refactor + v1/v2 rename + per-endpoint pools + premium splits

**Date:** 2026-05-05
**Status:** drafted, awaiting Rick go-ahead on Step A
**Driver:** before May 11 mainnet ship, lock the architectural framing in code so that:
1. Pact Network (rails) and Pact Market (one curated interface) are clearly separated
2. The two on-chain programs are explicitly versioned (v1 = ships now, v2 = future)
3. The v1 program isolates risk per endpoint instead of using a singleton coverage pool
4. The fetch-call wrap mechanism is a Network-core primitive, not Market-specific
5. Premium collection is enforced on-chain with a defined revenue split: most to the pool, smaller percentages to network treasury and integrator

## End vision after this refactor

**Pact Network core works on its own:**
- Smart contract (`pact-network-v1-pinocchio`) — per-endpoint coverage pools, agent prepaid wallets, batched per-call settlement, on-chain enforced premium split.
- Fetch-call wrap mechanism (`@pact-network/wrap`) — a library any integrator can use to insure any fetch call (timing, classification, balance check, event emission). Works without Pact Market.
- Settler service — generic; pulls events from a Network-defined sink and signs settle_batch.
- Indexer — generic; stores Network primitives.
- Basic developer documentation — README, architecture overview, "build your own integrator" guide, on-chain data model reference.

**Pact Market integrates Pact Network core:**
- `@pact-network/market-proxy` consumes `@pact-network/wrap` to wrap curated providers (Helius, Birdeye, Jupiter, Elfa, fal.ai).
- `@pact-network/market-dashboard` is the human-facing surface for Market specifically.
- Market is registered on-chain as an `integrator` on each endpoint it adds — earns the integrator share of every premium settled through its proxy.

**Acceptance test:** another team — without touching the Market codebase — could install `@pact-network/wrap` + `@pact-network/protocol-v1-client`, register their own endpoint with their own integrator pubkey, and start collecting insured calls. That is the proof Pact Network core is real.

## 0. Context

We have three on-chain programs in the repo today:

| Codebase ID | Crate | Program ID | Status |
|---|---|---|---|
| Anchor legacy | `pact-insurance` | `2Go74e…` | Legacy / rollback only per `CLAUDE.md` |
| Pinocchio insurance | `pact-insurance-pinocchio` | `7i9zJM…` (devnet) | Live; multi-underwriter parametric insurance |
| Pinocchio market | `pact-market-pinocchio` | `DhWibM…` (devnet, PR #61) | New; agent prepaid wallet + per-call settlement |

After this refactor:

- The Pinocchio market program (currently #61) becomes **v1** — the simpler, faster-to-ship rails that power the Pact Market product. Ships May 11.
- The Pinocchio insurance program (currently live) becomes **v2** — the future multi-underwriter design with third-party capital, oracle rates, claim filings. Stays on devnet, no May 11 deploy work.
- The Anchor legacy crate is left untouched (already documented as rollback-only).

## 1. Layering rules (the rule for every contributor)

**Pact Network = the rails.** On-chain programs, the fetch-call wrap library, settler, indexer, classifier protocol, Postgres schema, shared types. Generic; consumed by any interface.

**Pact Market = one interface.** Curated provider handlers (Helius, Birdeye, Jupiter, Elfa, fal.ai), the hosted Hono proxy that uses `@pact-network/wrap` under the hood, the dashboard UX, the demo allowlist, the brand surface agents call. One opinionated product on top of the rails.

**Versioning rule for on-chain programs:** `v1` = the simpler engine that ships first; `v2` = the underwriter marketplace evolution. Both are Network-layer artifacts, not Market-layer.

**Wrap mechanism layering rule:** the *protocol* of wrapping a fetch call (time it, check balance, forward, classify, emit event, attach `X-Pact-*` headers) lives in Network. *Per-endpoint classifier plugins* (how a JSON-RPC response vs a REST 4xx maps to ok/breach/no-charge) live in the consuming interface — Market ships its 5 provider plugins, future integrators ship their own.

## 2. Naming targets

### 2.1 On-chain crates

| Today | Target | Notes |
|---|---|---|
| `pact-market-pinocchio` (PR #61) | **`pact-network-v1-pinocchio`** | Same logic + per-endpoint pool refactor below; same program ID `DhWibM…` if upgrade authority available |
| `pact-insurance-pinocchio` (live) | **`pact-network-v2-pinocchio`** | Same logic, same program ID `7i9zJM…`; rename only |
| `pact-insurance` (Anchor legacy) | unchanged | Already legacy/rollback-only |

Alternative crate name considered: `pact-protocol-v1-pinocchio` / `pact-protocol-v2-pinocchio`. Slightly more semantically accurate, but `pact-network-v*` keeps consistency with the `@pact-network/` npm scope. **Recommendation: `pact-network-v1-pinocchio` / `pact-network-v2-pinocchio`. Rick to confirm.**

### 2.2 TypeScript packages

| Today | Target | Layer |
|---|---|---|
| `@pact-network/market-client` (Codama) | **`@pact-network/protocol-v1-client`** | Network rails |
| (no v2 client today; v2 has its own SDK at `@pact-network/insurance`) | rename to **`@pact-network/protocol-v2-client`** when it gets refreshed | Network rails |
| `@pact-network/db` | unchanged | Network rails ✓ |
| `@pact-network/settler` | unchanged | Network rails ✓ |
| `@pact-network/indexer` | unchanged | Network rails ✓ |
| `@pact-network/shared` | unchanged | Network rails ✓ |
| (does not exist yet) | **`@pact-network/wrap`** (new package) | Network rails — generic fetch-call wrap library |
| `@pact-network/proxy` | **`@pact-network/market-proxy`** (consumes `@pact-network/wrap`) | Market interface |
| `@pact-network/dashboard` | **`@pact-network/market-dashboard`** | Market interface |

### 2.3 Cloud Run service names (Wave 0 deploy)

| Default in current DEPLOY.md | Target |
|---|---|
| `pact-proxy` | **`pact-market-proxy`** |
| `pact-settler` | unchanged ✓ |
| `pact-indexer` | unchanged ✓ |

Public domains (`market.pactnetwork.io`, `dashboard.pactnetwork.io`, `indexer.pactnetwork.io`) are unchanged — already correctly scoped.

## 3. **Critical architectural change: per-endpoint coverage pools (v1)**

The current v1 design has a singleton `CoveragePool` PDA: `[b"coverage_pool"]`. **Rick's call: this is exploitable.** A correlated outage on one popular provider would drain the entire pool, leaving every other insured endpoint uncovered. Bad actors could orchestrate forced breaches on a low-risk endpoint to drain capital meant for high-risk endpoints. v2's design already isolates per-provider via `provider_hostname` on its CoveragePool. v1 must do the same before mainnet.

### 3.1 Account changes

**`CoveragePool` PDA seed change:**
- Today: `[b"coverage_pool"]` (singleton)
- Target: `[b"coverage_pool", endpoint_slug]` — one pool per registered endpoint slug

**`EndpointConfig` — add explicit pool reference:**
```rust
pub struct EndpointConfig {
    // ... existing fields ...
    pub coverage_pool: Pubkey, // 32 bytes; resolves to [b"coverage_pool", slug] PDA
}
```
This lets clients/settler resolve the pool without re-deriving the PDA every call, and gives us a future escape hatch: a `coverage_pool_key: [u8; 16]` field could let multiple endpoint slugs aggregate under one logical pool (e.g., all `helius-*` slugs share one pool keyed on root domain). For v1 ship, default `coverage_pool_key = slug`.

**Per-endpoint vs per-root-domain:** Rick offered both. Recommendation: ship per-endpoint-slug as the V1 PDA seed (simplest, isolates each slug's risk), and add a `coverage_pool_key` indirection via `EndpointConfig` so we can aggregate by domain later without a contract migration. **Rick to confirm.**

### 3.2 Instruction changes

| Instruction | Change |
|---|---|
| `initialize_coverage_pool` | Now takes `endpoint_slug` as input; one call per endpoint to bootstrap its pool. Fold into `register_endpoint` or keep separate. **Recommendation: fold into `register_endpoint`** — registering an endpoint creates its pool atomically, prevents the "registered but unfunded" state. |
| `top_up_coverage_pool` | Now takes `endpoint_slug` and credits that pool only |
| `settle_batch` | Each `SettlementEvent` already carries `endpoint_slug`. Handler resolves the per-event pool PDA and debits/credits each pool independently within the batch. Adds remaining accounts requirement: one CoveragePool + its USDC vault per unique endpoint in the batch. |
| `claim_refund` | No change — refunds come out of `AgentWallet` vault, not directly from a pool. |
| All other instructions | Unchanged |

### 3.3 Test surface to update

- `initialize_coverage_pool` happy + reject double-init for same slug
- `top_up_coverage_pool` only credits the targeted pool
- `settle_batch` with events spanning multiple endpoints — each pool debited/credited correctly, accounts-list ordering tested
- `settle_batch` rejects events for an endpoint whose pool isn't initialized
- Pool-depleted error scoped per pool, not global
- Hourly exposure cap still enforced per endpoint (already on EndpointConfig — no schema change)

### 3.4 Off-chain ripple effects

- **`@pact-network/protocol-v1-client`** (renamed Codama client): regen with new instruction signatures, expose `getCoveragePoolPda(endpointSlug)` helper.
- **Settler (#62):** before signing `settle_batch`, group events by `endpoint_slug`, derive pool PDAs, build the accounts list including one CoveragePool + USDC vault per unique slug in the batch. Update batcher to either (a) keep batches mixed but compute per-pool account groups, or (b) split batches by endpoint to keep account lists predictable. **Recommendation: (a) — keep batches mixed; the on-chain handler iterates events and resolves pools.**
- **Indexer schema (#59):** `PoolState` table changes from singleton to one row per endpoint:
  ```prisma
  model PoolState {
    endpointSlug          String   @id @db.VarChar(16)
    currentBalanceLamports BigInt
    totalDepositsLamports  BigInt
    totalPremiumsLamports  BigInt
    totalRefundsLamports   BigInt
    lastUpdated            DateTime
  }
  ```
  Plus optional aggregate view `PoolStateAggregate` for the dashboard hero stats.
- **Dashboard (#60):** `/` overview now shows aggregate across pools + per-pool breakdown; `/endpoints` table adds a "Pool balance" column.
- **Proxy (#58):** **no on-chain changes**. Proxy only emits events with the slug already attached.

### 3.5 Devnet redeploy required

The PDA seed change is a state-layout break. The existing devnet deploy (`DhWibM…`) was a smoke test only. After implementing 3.1-3.3, redeploy v1 cleanly. If the original deploy keypair is still the upgrade authority, redeploy at the same program ID; otherwise, accept a new ID and update one constant.

## 4. **Agent custody via SPL Token approval (v1)**

**Rick's call (2026-05-05):** the agent's wallet is managed by the agent, not by Pact. The current design has Pact custody the agent's USDC in an `AgentWallet` PDA — agent deposits in, settler debits, agent withdraws after a cooldown. That's Pact-managed custody, not agent-managed. Wrong shape. v1 must use **SPL Token approval/delegation** so the agent always holds custody.

### 4.1 The model

- Agent keeps USDC in their own ATA at their own pubkey. Pact never holds it.
- Agent grants Pact's `SettlementAuthority` PDA a spending allowance via the standard SPL Token `Approve` instruction (one wallet click in the dashboard).
- Settler debits directly from the agent's USDC ATA on `settle_batch` using delegate authority. No PDA-custody, no deposit step.
- Agent can call SPL Token `Revoke` at any time. Future debits then fail at the SPL Token level; settler logs and skips those events.
- Refunds come from the CoveragePool **directly to the agent's USDC ATA**. No claim step.

### 4.2 What goes away from the v1 program

The following accounts and instructions are **removed** from the v1 program:

| Removed | Why |
|---|---|
| `AgentWallet` PDA + USDC vault | No more PDA custody — agent holds their own USDC |
| `initialize_agent_wallet` instruction | Agent just needs a regular USDC ATA at their own pubkey |
| `deposit_usdc` instruction | No deposit; agent grants approval to a delegate |
| `request_withdrawal` instruction | No withdrawal; agent always has custody |
| `execute_withdrawal` instruction | Same |
| `WITHDRAWAL_COOLDOWN_SECS = 86_400` constant | Irrelevant under continuous custody |
| `MAX_DEPOSIT_LAMPORTS = 25_000_000` constant | No protocol-side deposit cap; agent decides their own approval amount |
| `claim_refund` instruction | Refunds go directly to agent's USDC ATA from the pool inside `settle_batch` |
| Dashboard auto-claim hook (`useRefundClaimer`) | Refunds appear in agent's wallet automatically |

That's **5 instructions and 1 PDA** removed from the v1 program. Net result is simpler code, simpler tests, simpler UX, and continuous agent custody — all without losing any functionality the V1 product needs.

### 4.3 Settle_batch flow under agent custody

Per event, with the channeling rule from §5 still applied:
1. **Premium-in:** transfer `agent USDC ATA → endpoint's CoveragePool vault` for the **full premium**, signed by the `SettlementAuthority` PDA via SPL Token delegate authority (the agent pre-approved this). Source uses the SPL Token program's `Transfer` ix with the delegate as authority.
2. **Non-pool fan-out:** for each non-pool recipient, transfer `CoveragePool vault → recipient.destination` for that recipient's bps share. CoveragePool authority signs (program PDA).
3. **On breach:** transfer `CoveragePool vault → agent's USDC ATA` for the refund amount. Agent receives refund directly with no extra step.

If the SPL Token delegate authority has been revoked or the approved amount is insufficient at the moment of settle, the SPL Token Transfer fails. The program catches that, marks the event as `settlement_failed`, and continues with the rest of the batch. Settler still acks Pub/Sub for the failed event and logs it; agent loses that call's coverage but is otherwise unaffected. Indexer records the failure for the dashboard to surface ("Approval expired — re-approve to resume insured calls").

### 4.4 Required fields on remaining accounts

`EndpointConfig` and `CoveragePool` are unchanged from §3.

A small new state account (optional but recommended) for per-agent stats lives off-chain in the indexer rather than on-chain — there's no on-chain account for an agent in v1 anymore. Per-agent metrics (lifetime premiums paid, refunds received, calls covered) are aggregated by the indexer from `CallRecord` PDAs, which already exist for dedup.

`SettlementAuthority` PDA stays — it's the delegate the agent approves and the signer for `settle_batch`.

### 4.5 Approval UX in the dashboard

First-time agent flow:
1. Connect wallet (Phantom/Solflare/Backpack).
2. Dashboard checks: does this agent's USDC ATA exist? If not, prompt to create (~0.002 SOL rent).
3. Dashboard checks: does the SettlementAuthority PDA have an active approval? If not, prompt: "Approve $25 spending allowance for Pact to insure your API calls" — one wallet click.
4. Done. Agent makes calls; premiums auto-debit from their ATA up to the approved amount.

When allowance is exhausted, dashboard banner: "Approval used up — re-approve to keep making insured calls." One-click top-up of allowance.

Revoke any time: a "Stop insurance" button calls SPL Token `Revoke` directly. No protocol-side cooldown.

### 4.6 Off-chain ripple

- **`@pact-network/wrap`** balance check: reads the agent's USDC ATA balance AND the ATA's `delegated_amount` (allowance remaining). Both must exceed the premium for the call to be insured.
- **`@pact-network/protocol-v1-client`**: removes builders for `initialize_agent_wallet`, `deposit_usdc`, `request_withdrawal`, `execute_withdrawal`, `claim_refund`. Adds helper `buildApproveIx(agent, settlementAuthority, allowance)` — wraps the standard SPL Token Approve. Adds helper `getAgentInsurableState(agent)` — returns `{ ataBalance, allowance, eligible }`.
- **Settler (#62)**: builds settle_batch txs using SettlementAuthority as delegate signer for the agent ATA → CoveragePool transfers; CoveragePool authority signer for the fan-out and refund transfers.
- **Indexer (#59)**: per-agent stats now live in a denormalized `Agent` table fed by `CallRecord` aggregation. No on-chain `AgentWallet` to read.
- **Dashboard (#60)**: `useAgentWallet` hook becomes `useAgentInsurableState` — reads ATA balance + allowance via SPL Token program calls. Removes `useRefundClaimer` (no auto-claim needed). Adds approve/re-approve/revoke buttons.
- **Proxy (#58)** and **`@pact-network/wrap`**: balance-check pre-flight uses ATA balance + allowance instead of AgentWallet PDA balance.

### 4.7 Implications for §3 (per-endpoint pools), §5 (premium splits), §6 (sequencing)

- §3 unchanged — pools are still per-endpoint. Source/destination semantics for pool transfers updated downstream.
- §5 channeling rule unchanged — `agent ATA → CoveragePool` (full premium), then `CoveragePool → non-pool recipients` (their bps shares). The agent ATA replaces what was previously the AgentWallet vault as the source.
- §6 sequencing — Step C absorbs this change as part of the v1 program rewrite (same redeploy). 5 instructions removed, no new instructions added on top of what §3/§5 already require.

---

## 5. New Network-core package: `@pact-network/wrap`

The fetch-call wrap mechanism is extracted from `@pact-network/market-proxy` into a standalone Network-core library so any interface (Market, BYO SDK, x402 facilitator) can use it.

### 4.1 What lives in `@pact-network/wrap`

Generic primitives:
- `wrapFetch(opts)` — the request lifecycle: timer start → balance check → forward → timer end → classify → emit event → attach `X-Pact-*` headers → return.
- `BalanceCheck` interface — pluggable; default impl reads `AgentWallet.balance` via Solana RPC with LRU cache.
- `Classifier` interface — input: response + latency + endpoint config; output: `{ premium, refund, breach, reason }`. Network ships abstract types and a "default classifier" (latency vs `sla_latency_ms`, 5xx → breach, 429 → no-charge, network-error → server_error). Each interface adds its own per-endpoint protocol plugins on top.
- `EventSink` interface — pluggable: `PubSubEventSink` (Market default), `HttpEventSink` (for SDK use cases that POST directly to a Network settlement endpoint), `MemoryEventSink` (testing). Settler doesn't care which sink the producer used as long as the message shape conforms to `SettlementEvent`.
- Header constants — `X-Pact-Premium`, `X-Pact-Refund`, `X-Pact-Latency-Ms`, `X-Pact-Outcome`, `X-Pact-Pool`, `X-Pact-Settlement-Pending`.
- `SettlementEvent` schema (also exported from `@pact-network/shared`).

### 4.2 What stays in `@pact-network/market-proxy`

Market-specific:
- Hono server + Cloud Run runtime
- Per-provider classifier plugins (`classifiers/helius.ts`, `classifiers/birdeye.ts`, `classifiers/jupiter.ts`, etc.)
- Force-breach demo mode (`?demo_breach=1`, `DemoAllowlist` check)
- Bearer-token reload-endpoints route
- DEPLOY.md gcloud commands
- Public domain wiring for `market.pactnetwork.io`

### 4.3 Acceptance: another integrator can build their own wrap consumer

```ts
// An external team's SDK
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

If this snippet works against a network where their endpoint is registered with their integrator pubkey, Network core has shipped.

---

## 5. **On-chain premium collection + interchangeable revenue split (v1)**

Today the v1 program transfers the entire premium from `AgentWallet` to `CoveragePool`. **Rick's call: premium collection must be enforced on-chain with most of the premium going to the pool and percentages going to other parties — and the recipient list must be interchangeable**, not hardcoded to fixed slots like "treasury/integrator." Pact Network ships a generic recipients model so future parties (oracles, underwriters, referrers, governance) can be added without contract upgrades.

**Routing rule (Rick, 2026-05-05):** the agent-to-network funding channel is **AgentWallet → CoveragePool — period**. The agent's wallet only ever debits to the pool. Any other-party shares (treasury, integrator, etc.) are paid out **from** the pool, not directly from the agent. This makes the pool the single accounting hub for all premium flow — gross premium-in is always visible on the pool, and every outflow has the pool as its source.

**V1 scope reminder (Rick, 2026-05-05):** **v1 has no external underwriters.** Pact funds the coverage pool itself; there are no `UnderwriterPosition` accounts, no underwriter deposits, no underwriter capital at risk, no claim-approval flow, no oracle-driven rates. The interchangeable recipients model is forward-compatible — v2 can later add an `Underwriter` recipient kind (or `PdaUsdcVault` pointing at v2's underwriter program) without a v1 contract upgrade — but **v1 ships with exactly three parties: CoveragePool (Pact-funded), Treasury (Pact protocol fee), Integrator (Pact Market today, BYO integrators later).** Anything resembling underwriter logic stays in the v2 program (`pact-network-v2-pinocchio`) and is out of scope for the May 11 ship.

### 5.1 The model: pool gets the residual, fees come off the top

**Rick's framing (2026-05-05):** "When a premium is paid, some will go to us, some might or might not go to affiliates, and the rest stays in the CoveragePool."

The on-chain model that matches this exactly:

- **The pool is the residual**, not a fixed-bps slot. It does not appear in the recipients array. Whatever isn't paid out as a fee stays in the pool.
- **Fee recipients** are an interchangeable list. Each has a kind, a destination, and a bps share *of the premium*. They are the only entries in the recipients array.
- **Fees are extracted at the moment the premium is paid** — same on-chain `settle_batch` instruction, same tx, same atomic operation. No periodic sweeps, no async settlement.
- **In v1, the fee recipients are: Treasury (always — Pact's protocol fee) and zero or more Affiliates (optional — integrators who registered the endpoint).**

```rust
#[repr(u8)]
pub enum FeeRecipientKind {
    Treasury     = 0, // singleton Pact protocol fee; destination = Treasury PDA
    AffiliateAta = 1, // affiliate / integrator USDC ATA (raw pubkey)
    AffiliatePda = 2, // affiliate USDC vault owned by a PDA (e.g., a multisig)
    // future kinds (Oracle, Governance, Referrer, Underwriter) added by upgrade
    // only if they need custom transfer semantics; most additions can use
    // AffiliateAta / AffiliatePda without touching the program.
}

#[repr(C)]
pub struct FeeRecipient {
    pub kind: u8,            // FeeRecipientKind
    pub destination: Pubkey, // 32 bytes; semantics depend on kind
    pub bps: u16,            // share in basis points off the premium
    pub _pad: [u8; 5],       // align to 40 bytes
}
```

**Validation invariants** (enforced by program code on `register_endpoint` and `update_endpoint_config`):
- `fee_recipient_count <= MAX_FEE_RECIPIENTS` (8)
- `sum(fee_recipient.bps) <= 10_000` — strict less-than-or-equal; if it equals 10_000, every premium is fully extracted as fees and the pool gets nothing (legal but pointless; warning logged off-chain at register time)
- Sum of `Treasury` kind bps appears at most once across the array
- No two recipients with the same `destination`
- For `kind == AffiliateAta`, `destination` must be a valid USDC ATA at registration time (validated against configured USDC mint)
- For `kind == Treasury`, `destination` must equal the Treasury PDA's USDC vault (resolved at runtime, not stored as a literal)

**Sane-fee guardrail (recommended, Rick to confirm):** enforce `sum(fee_recipient.bps) <= MAX_TOTAL_FEE_BPS` (default `MAX_TOTAL_FEE_BPS = 3000` = 30%) at the protocol level. Prevents a misconfigured endpoint from starving the pool of capital. Pool authority can override via a separate "raise-fee-cap" admin instruction if a future product needs higher fees.

**`EndpointConfig` shape:**
```rust
pub struct EndpointConfig {
    // ... existing fields ...
    pub coverage_pool: Pubkey,    // from §3 — the residual destination, never in the recipients array
    pub fee_recipient_count: u8,
    pub _pad: [u8; 7],
    pub fee_recipients: [FeeRecipient; 8], // first `fee_recipient_count` are valid
}
```

**`ProtocolConfig` defaults:**
```rust
pub struct ProtocolConfig {
    pub max_total_fee_bps: u16,            // protocol-level fee cap, default 3000
    pub default_fee_recipient_count: u8,
    pub _pad: [u8; 5],
    pub default_fee_recipients: [FeeRecipient; 8],
    // ... other fields ...
}
```
On `register_endpoint`, if the caller doesn't pass a fee_recipients array, the program copies `default_fee_recipients` (typically just Treasury at the protocol-default rate).

### 5.2 Why fixed-size array, not Vec

Pinocchio has no allocator. Variable-length state requires explicit length tracking and reallocation logic, which adds complexity and bug surface. A fixed-size array of 8 entries gives 8 × 40 bytes = 320 bytes of recipient data per endpoint — comfortable and predictable. 8 fee recipients is plenty for any realistic split (today: Treasury + 0-N Affiliates; near-future: + Oracle + Referrer + Governance still leaves 4 slots free).

### 5.3 Default fee template for V1 (Rick to confirm)

| # | Kind | Destination at register time | Default bps | Percentage of premium |
|---|---|---|---|---|
| 0 | Treasury | Treasury PDA USDC vault (singleton) | 1000 | 10% |
| 1 | AffiliateAta | passed at register time (e.g., Pact Market's USDC ATA) — **optional**, omit to send 0 to affiliates | 500 | 5% |
| **Total fees** | | | **1500** | **15%** |
| **Pool retains** | | | **8500** | **85%** (residual) |

Endpoints registered without an affiliate (all fields default) get `[Treasury 10%]` — pool retains 90%. Endpoints registered through Pact Market specify Market's ATA as Affiliate at 5% — pool retains 85%. Future BYO integrators set their own affiliate pubkey + bps (subject to the 30% protocol cap).

Rick can override these defaults at protocol-init time, and any endpoint can override at register time or via `update_fee_recipients` afterward.

### 5.4 Account changes (v1)

**`Treasury` account** (unchanged from prior version):
- PDA seeds: `[b"treasury"]` (singleton)
- Holds USDC vault
- Authority = pool authority (V1) → multisig (mainnet checklist)
- Initialized via new `initialize_treasury` instruction

**`EndpointConfig`**: as in §5.1 above.

**`ProtocolConfig`**: stores default recipient template + other protocol params.

### 5.5 Instruction changes

| Instruction | Change |
|---|---|
| `initialize_treasury` | **NEW** — singleton bootstrap |
| `initialize_protocol_config` | **NEW (or extended)** — sets `max_total_fee_bps` + default fee recipient template |
| `register_endpoint` | Takes optional `fee_recipients: Option<[FeeRecipient; 8]>` + `fee_recipient_count`; defaults from ProtocolConfig if omitted; enforces all §5.1 invariants |
| `update_fee_recipients` | **NEW** — replaces the fee_recipients array atomically; pool authority only; same invariants enforced |
| `settle_batch` | Per event: **(1)** transfer **agent USDC ATA → CoveragePool vault** for the **full premium** (using SettlementAuthority delegate authority per §4); **(2)** for each fee_recipient in the endpoint's fee_recipients array, compute `fee_amount = premium * recipient.bps / 10_000` and transfer **CoveragePool vault → recipient.destination**. The pool's net retention = premium − sum(fee_amounts), which stays in the pool by virtue of not being paid out. Refunds (on breach) come from the CoveragePool's residual balance straight to the agent's USDC ATA |

**Why this satisfies "revenue extraction FROM the premium, AT premium-payment time":**
- The fees come *off* the premium that just landed in the pool, in the same `settle_batch` instruction, in the same tx. There is no separate sweep, no later step, no second transaction.
- The agent's wallet sees a single debit (full premium → pool). The agent doesn't need to know fees exist.
- The pool's `total_premiums_earned` reflects gross premium-in. The pool's `total_fees_paid` (new field, see §5.4) reflects fee outflows. The pool's net = gross − fees − refunds.

**Rounding rule:** fee shares use rounded-down bps math; the pool absorbs the rounding remainder by construction (it gets "the premium minus paid-out fees"). Bias toward pool capital adequacy.

**Min-premium guard:** unchanged — `MIN_PREMIUM_LAMPORTS = 100`. Validator warns at register time if any fee `bps < (10_000 / MIN_PREMIUM_LAMPORTS)` because that fee would round to zero on minimum-premium calls.

**Authorization:** only the pool authority can call `update_fee_recipients`. SettlementAuthority is the only party authorized to invoke `settle_batch`.

### 5.6 Account list growth in `settle_batch`

Per unique endpoint in a batch:
- CoveragePool PDA + USDC vault (mutable; receives premium-in, source of all fee payouts)

Per unique fee recipient destination across the batch (deduplicated):
- Treasury PDA + USDC vault — singleton, one per batch (when at least one event has Treasury in its fee_recipients)
- Each unique `AffiliateAta` destination — one per batch
- Each unique `AffiliatePda` destination

Plus Token Program + System Program (singletons).

Worst case for V1 (5 endpoints, default 3-recipient template, single Market integrator):
- 5 CoveragePool + 5 vaults = 10 accounts
- 1 Treasury + 1 vault = 2 accounts
- 1 Market integrator ATA = 1 account
- 1 Token Program + 1 System Program = 2 accounts
- = ~15 accounts beyond per-event AgentWallet/CallRecord/EndpointConfig

Important: routing through the pool means **2 transfers per event per recipient** (1 in + N out) instead of N parallel out — slightly higher CU usage. Surfpool benchmark before Friday confirms compute budget when batch_size = 50 with the channel-then-fan-out flow.

### 5.7 Test surface

Mandatory before redeploy:
- **Default-template happy path**: agent pays 1000 lamport premium, default fees `[Treasury 10%, Affiliate 5%]` → agent ATA drops by 1000, pool gross-credits 1000, pool debits 100 to Treasury and 50 to Affiliate, pool net retains 850
- **No-affiliate path**: endpoint registered without Affiliate, only `[Treasury 10%]` → premium 1000 → Treasury 100, pool retains 900
- **Multiple-affiliate path**: endpoint registered with `[Treasury 10%, Affiliate-A 3%, Affiliate-B 2%]` → premium 1000 → Treasury 100, A 30, B 20, pool retains 850
- **Pool-as-source for fee payouts**: assert each Affiliate's signed-transfer source is the CoveragePool vault, not the agent's ATA
- **Split math**: premium 1001 with `[Treasury 10%, Affiliate 5%]` → fees 100+50, pool retains 851 (residual absorbs +1 rounding)
- **Validation rejects**: `sum(bps) > 10_000`; `sum(bps) > MAX_TOTAL_FEE_BPS`; duplicate destinations; AffiliateAta with non-USDC mint; fee_recipient_count > 8; multiple Treasury entries
- **Atomic update**: `update_fee_recipients` replaces the whole array; partial-update semantics not supported
- **Mixed-batch**: 3 events from 3 different endpoints with 3 different fee templates — each event extracts fees from its endpoint's pool independently
- **Refund path**: breach event triggers `pool → agent ATA` refund directly; no fee recipients touched on refund; agent's USDC ATA balance increases by the refund amount in the same tx
- **Authorization**: non-pool-authority `update_fee_recipients` rejected; non-SettlementAuthority `settle_batch` rejected
- **Min-premium edge**: 100-lamport premium with `[Treasury 10%, Affiliate 5%]` → Treasury 10, Affiliate 5, pool retains 85 (each ≥1, no zero-share)
- **Approval-revoked path** (per §4): if agent revoked SPL Token approval before settle, the agent ATA → pool transfer fails; event marked `settlement_failed`; rest of batch unaffected

### 5.8 Off-chain ripple

- **`@pact-network/protocol-v1-client`**: regen exposes new types (`FeeRecipient`, `FeeRecipientKind` enum) + helpers `defaultFeeRecipients(affiliateAta?)`, `validateFeeRecipients(recipients)`, `accountListForBatch(events)` (returns the de-duplicated tx accounts list, each endpoint's CoveragePool marked mutable, fee recipient ATAs/PDAs included).
- **Settler (#62)**: account-list builder iterates events, deduplicates `(kind, destination)` tuples across the batch, ensures each endpoint's CoveragePool vault is `mutable` (destination of premium-in AND source of fee payouts AND source of refunds within the same tx). Settler doesn't compute the split itself — the program reads the EndpointConfig fee_recipients array on-chain and does the channel-then-fan-out.
- **Indexer schema (#59)**: switch from fixed `totalPoolLamports / totalTreasuryLamports / totalIntegratorLamports` columns to a generic per-recipient breakdown that tracks gross premium-in to the pool plus each non-pool outflow:
  ```prisma
  model SettlementRecipientShare {
    id                String   @id @default(cuid())
    settlementSig     String
    recipientKind     Int      // RecipientKind enum
    recipientPubkey   String   @db.VarChar(44)
    amountLamports    BigInt
    settlement        Settlement @relation(fields: [settlementSig], references: [signature])
    @@index([recipientPubkey])
    @@index([settlementSig])
  }

  model Settlement {
    signature             String   @id
    batchSize             Int
    totalPremiumsLamports BigInt
    totalRefundsLamports  BigInt
    ts                    DateTime
    shares                SettlementRecipientShare[]
  }

  model RecipientEarnings {
    recipientPubkey       String   @id @db.VarChar(44)
    recipientKind         Int
    lifetimeEarnedLamports BigInt
    lastUpdated           DateTime
  }
  ```
  Aggregate views: total per kind, total per pubkey, top integrators, total treasury accumulated.
- **Dashboard (#60)**: `/` overview shows aggregated stats per kind (total to pools, total to treasury, total to all integrators) and a top-N integrator leaderboard if useful. `/endpoints/[slug]` page shows the current recipients array so anyone can audit the split.
- **Proxy (#58)**: no changes — proxy emits the same event shape; the split is computed entirely on-chain from the recipients array.

### 5.9 Future-proofing

- Adding a new fee "kind" (e.g., `Underwriter` for v2, `Oracle`, `Governance`, `Referrer`) requires a contract upgrade only if the transfer semantics differ from existing kinds. Most new parties can use `AffiliateAta` or `AffiliatePda` without touching the program — they're just a different label on the same transfer mechanism.
- v2's underwriter pools become an `AffiliatePda` fee kind on v2 endpoints (or a new `Underwriter` kind if v2 wants distinct accounting), no v1 program changes needed.
- Time-varying fee schedules (promotional rates, lockups) are a v1.1 feature: add `effective_at: i64` to `FeeRecipient` and let `settle_batch` pick the active set per event timestamp. Out of scope for May 11 ship.

---

## 6. Sequencing against open PRs

Five Wave 1 PRs are in flight on top of `feat/pact-market-phase0` (#48). The order minimizes rebase pain.

**Step A — Spec/plan docs (PR #57):** *docs only, no code*
- Add §1.x "Pact Network rails vs Pact Market interface" to `2026-05-05-pact-market-execution-design.md`.
- Add §11.x: per-endpoint pool model + `coverage_pool_key` indirection.
- Add §11.y: premium split + Treasury account + integrator field on EndpointConfig.
- Add §3.x: `@pact-network/wrap` library responsibility split (Network) vs interface-specific classifier plugins.
- Re-label §3 components by layer (Network rails vs Market interface).
- Re-label plan tasks: Wave 1A → "Network v1 program"; Wave 1B/1E → Market interface.
- Move #57 out of draft.

**Step B — Phase 0 scaffold rename + new Network packages (PR #48):**
- Rename: `packages/proxy/` → `packages/market-proxy/`
- Rename: `packages/dashboard/` → `packages/market-dashboard/`
- Rename: `packages/market-client/` (if present in #48) → `packages/protocol-v1-client/`
- **NEW package: `packages/wrap/`** with `@pact-network/wrap` package.json — empty scaffold, real implementation in Step D
- Update `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` paths
- Update root README

**Step C — v1 program: rename + per-endpoint pool refactor + premium split + treasury (PR #61):**

This is the heaviest step. Three on-chain changes bundled into one program update so we redeploy v1 once.

- C.1 Rename Rust crate dir: `packages/program/programs-pinocchio/pact-market-pinocchio/` → `pact-network-v1-pinocchio/`
- C.2 Update `Cargo.toml` package name + workspace members + lib name (`pact_market_pinocchio` → `pact_network_v1_pinocchio`)
- C.3 **Implement per-endpoint pool refactor** (§3): seed change, EndpointConfig `coverage_pool` field, instruction signatures, handler logic
- C.4 **Implement premium split + treasury** (§5): `Treasury` PDA + `initialize_treasury` instruction; `ProtocolConfig` defaults; `EndpointConfig` adds `integrator` + `pool_bps` + `treasury_bps` + `integrator_bps`; `register_endpoint` accepts split overrides; `update_endpoint_config` allows split updates; `settle_batch` computes three-way transfer per event
- C.5 Update LiteSVM tests: existing 29 + new per-pool tests (§3.3) + new split tests (§5.6) + treasury init/double-init guards
- C.6 TS client dir + name: `packages/market-client/` → `packages/protocol-v1-client/`, `@pact-network/market-client` → `@pact-network/protocol-v1-client`
- C.7 Codama regen against new IDL: new builders for `initialize_treasury`, updated `register_endpoint` signature, helpers `getCoveragePoolPda(slug)` + `getTreasuryPda()`
- C.8 `cargo build-sbf` clean
- C.9 Redeploy to devnet (same program ID `DhWibM…` if upgrade authority intact)
- C.10 Update `DEPLOYED_PROGRAM_ID.md` + READMEs

**Step C' — v2 program rename (separate small PR off `develop`):**
- Rename `packages/program/programs-pinocchio/pact-insurance-pinocchio/` → `pact-network-v2-pinocchio/`
- Update Cargo.toml + workspace; same program ID `7i9zJM…`; no semantic changes
- Update test imports (`pact_insurance_pinocchio` → `pact_network_v2_pinocchio`)
- Rename `@pact-network/insurance` SDK package: alias to `@pact-network/protocol-v2-client` (one-release deprecation)
- Update root `CLAUDE.md` references

**Step D — Implement Network wrap library + rebase Wave 1 PRs:**

*Sub-step D.0 — implement `@pact-network/wrap` (NEW work, blocks #58 rebase):*
- Move generic wrap logic out of #58's proxy code into `packages/wrap/src/`:
  - `wrapFetch()` request lifecycle
  - `BalanceCheck`, `Classifier`, `EventSink` interfaces
  - Default classifier (latency/5xx/429/network-error)
  - `PubSubEventSink`, `HttpEventSink`, `MemoryEventSink` implementations
  - `X-Pact-*` header constants
- Tests: each interface, default classifier, each sink. Target ≥90% coverage.

*PR #58 (proxy → market-proxy):*
- Rebase on new #48 base; package now at `packages/market-proxy/`
- Update `package.json` name → `@pact-network/market-proxy`
- Add workspace dep: `@pact-network/wrap`
- **Refactor proxy to consume `@pact-network/wrap`**: Hono routes call `wrapFetch()` with PubSubEventSink; per-provider classifiers (`classifiers/helius.ts`, `birdeye.ts`, `jupiter.ts`) become plugins implementing the wrap library's `Classifier` interface
- Force-breach demo mode + DemoAllowlist stays in market-proxy (Market-specific)
- Update Dockerfile + DEPLOY.md (`pact-proxy` → `pact-market-proxy` service name)
- Tests stay green (40/40); add wrap-library integration tests

*PR #62 (settler):*
- Rebase on new #48 base
- Drop the copied `packages/market-client/` directory (the Wave 2 TODO)
- Update workspace dep: `@pact-network/market-client` → `@pact-network/protocol-v1-client`
- Update all imports in `apps/settler/src/**`
- **Per-pool account-list builder** (§3.7): group batch events by slug, derive pool PDAs, append one CoveragePool + USDC vault per unique slug
- **Per-integrator account-list builder** (§5.5): resolve each endpoint's `integrator` pubkey + USDC ATA; append per unique integrator in batch
- **Treasury account always appended** (singleton)
- Update settler tests for batches spanning multiple endpoints with different integrators

*PR #59 (indexer):*
- Rebase on new #48 base
- **Update Prisma schema for per-endpoint PoolState** (§3.7)
- **Update `Settlement` schema for split totals** (§5.7) + add `IntegratorEarnings` aggregate table
- Migration applies to empty devnet DB cleanly
- Add aggregate views for dashboard hero stats (across pools, total treasury earned, top integrators)
- `ops.controller.ts`: import path → `@pact-network/protocol-v1-client`

*PR #60 (dashboard → market-dashboard):*
- Rebase on new #48 base; package now at `packages/market-dashboard/`
- Update `package.json` name → `@pact-network/market-dashboard`
- Update Vercel project name + env var prefixes
- Replace `lib/solana.ts` placeholder builders with `@pact-network/protocol-v1-client` imports
- `/endpoints` table: add "Pool balance" + "Integrator" + "Split" columns
- `/` hero stats: aggregate-across-pools + Treasury earned + top integrator earnings
- Per-agent page unchanged (agents only see their own premiums + refunds)

**Step E — Cloud Run + DNS (Wave 0 deploy time):**
- Deploy `pact-market-proxy` service (not `pact-proxy`)
- DNS unchanged: `market.pactnetwork.io` → new service
- Settler/indexer service names unchanged

**Step F — Documentation cleanup (one PR after D):**
- Root `CLAUDE.md`: rewrite product description to align with Network rails + Market interface layering
- Root README: updated package map showing Network packages vs Market packages
- `docs/` reorg: split `docs/pact-market/` into `docs/pact-network/` (protocol, on-chain reference, wrap library) and `docs/pact-market/` (interface specifics); move `pinocchio-delta.md` to `docs/pact-network/`
- `CHANGELOG.md` entries

**Step G — Network core developer documentation (one PR after F):**

This is what makes the end vision real — basic docs that prove Pact Network core stands alone.

- G.1 `docs/pact-network/README.md` — what Network is, what it gives you, what it doesn't
- G.2 `docs/pact-network/architecture.md` — diagram + component-by-component walkthrough (program, wrap lib, settler, indexer)
- G.3 `docs/pact-network/protocol-reference.md` — every on-chain account + every instruction + every error code
- G.4 `docs/pact-network/wrap-library.md` — `@pact-network/wrap` API reference + the integrator example from §4.3
- G.5 `docs/pact-network/build-your-own-integrator.md` — step-by-step: register your endpoint, choose your split, install `@pact-network/wrap`, start collecting insured calls
- G.6 `docs/pact-network/economics.md` — how premium splits work, how to set them, how integrators earn
- G.7 README badges + cross-links from root README

## 7. Risks

| Risk | Mitigation |
|---|---|
| v1 upgrade authority lost — can't redeploy at same program ID | Verify keypair availability before C.9; if lost, deploy at new ID and update the one constant in `protocol-v1-client` + DEPLOY.md |
| Bundling 3 on-chain changes (rename + per-pool + split) creates a long debugging window | LiteSVM tests must cover each change in isolation before integration; `cargo build-sbf` and tests run per commit; no single mega-commit |
| Account-list size explodes when batches span many endpoints + integrators | Worst-case V1 batch: 5 pools + 1 treasury + 1 integrator (Market) = ~7 extra accounts per tx beyond per-event. Comfortably within Solana tx limits. Surfpool benchmark before Friday to confirm compute budget |
| Rebase conflicts pile up across 5 PRs | Strict A→B→C→D order; #48 and #61 force-pushed once each; coordinate with the original PR author (`tu11aa`) before force-pushing their branches |
| `@pact-network/wrap` extraction introduces regressions in the proxy hot path | Keep #58's existing 40 tests as the regression bar; wrap library has its own unit tests; integration test exercises Hono → wrap → upstream → event end-to-end before merge |
| Premium-split rounding edge cases drain dust over time | Document rounding rule (pool absorbs); test confirms premium=1 lamport with any split rounds to 100% pool; min-premium guard ensures no zero-share for any party at sane premium values |
| Treasury account becomes a single-key liability | V1 ships with treasury authority = pool authority (acceptable for $200 seed pool). Mainnet checklist (PRD §20) adds task: rotate treasury authority to multisig before mainnet flip |
| v2 rename breaks the live `@pact-network/insurance` SDK consumers | Alias `@pact-network/insurance` → `@pact-network/protocol-v2-client` for one release; deprecation notice in changelog |
| Mainnet timeline pressure pushes us to skip per-endpoint pool refactor or premium splits | Don't. Singleton pool with $200 seed is trivially drainable; un-enforced premium collection means Pact has no on-chain revenue and the integrator-share story is just marketing. Both are bounded work and core to the end vision |

## 8. What's needed from Rick before starting

1. **Crate naming:** `pact-network-v1-pinocchio` + `pact-network-v2-pinocchio` (recommended), or alternative `pact-protocol-v*-pinocchio`.
2. **Pool keying:** per-endpoint-slug (recommended) with `coverage_pool_key` indirection on EndpointConfig for future per-domain aggregation.
3. **Premium split defaults:** 8500 / 1000 / 500 bps (pool / treasury / integrator) — confirm or override.
4. **Rounding remainder:** pool absorbs (recommended for capital adequacy) vs integrator absorbs.
5. **Treasury authority:** same as pool authority, or distinct treasury authority pubkey?
6. **Integrator pubkey for V1 Market endpoints:** which Pact-controlled wallet receives the integrator share for the 5 launch endpoints?
7. **v1 upgrade authority:** is the keypair that deployed `DhWibM…` available, so we can redeploy at the same program ID?
8. **v2 SDK rename:** alias-and-deprecate `@pact-network/insurance` → `@pact-network/protocol-v2-client` (recommended) or hard-rename?
9. Go-ahead to start with **Step A** (docs only, fully reversible).

## 9. Verification gate (per PR)

- `pnpm install` clean from root
- `pnpm -r build` green
- `pnpm -r typecheck` green
- `pnpm -r test` green
- For **#61**: `cargo build-sbf` green; LiteSVM tests green (existing 29 + per-pool §3.3 + premium-split §5.6 + treasury init); devnet redeploy + smoke
- For **`@pact-network/wrap`** (Step D.0): unit tests for each interface, default classifier, each sink; ≥90% coverage; integration test with mock upstream
- For **#58 (market-proxy)**: existing 40 tests stay green after wrap-lib refactor; new wrap-integration tests
- For **#62 (settler)**: local e2e against devnet — multi-endpoint batch with multiple integrators settles correctly, Treasury credited, integrator ATAs credited
- For **#59 (indexer)**: Prisma migration applies cleanly (empty devnet DB); query plans reasonable on PoolState + Settlement + IntegratorEarnings
- **End-to-end network-core acceptance** (before mainnet flip): a synthetic "external integrator" test — register a 6th endpoint with a different integrator pubkey, install `@pact-network/wrap` directly (no market-proxy), make a call, assert premium splits land in pool/treasury/integrator correctly. This is what proves the end vision shipped.
- `scripts/e2e-devnet.sh` (spec §7.2) passes twice in a row before mainnet flip
