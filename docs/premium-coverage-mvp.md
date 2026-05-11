# Premium coverage MVP — `dummy.pactnetwork.io` worked example + `pact pay` facilitator design

This doc has two parts:

- **Part A** — the gateway path (`pact <url>`) that *already* charges premiums
  and pays refunds today, traced end-to-end with `pact-dummy-upstream` as the
  worked example, plus the exact operator runbook to make the demo live.
- **Part B** — the `pact pay` (pay.sh / x402) facilitator that *does not exist
  yet*: `facilitator.pact.network`, its routing model, refund-funding source,
  and a PR-sized task breakdown.

The on-chain protocol is `pact-network-v1-pinocchio` (program ID in
`packages/protocol-v1-client/src/constants.ts`). Off-chain: `market-proxy`
(the `api.pactnetwork.io/v1/<slug>/*` gateway) → `@pact-network/wrap` →
Pub/Sub → `settler` → `settle_batch` on-chain → `indexer` → Postgres.

---

## Part A — gateway path (works today)

### A.0 The shape of the thing

```
agent (pact CLI)                          api.pactnetwork.io                       Solana
       │  pact https://dummy.pactnetwork.io/quote/AAPL?fail=1
       │  → CLI maps host "dummy.pactnetwork.io" → slug "dummy" via
       │    /.well-known/endpoints (hostnames map), signs the request
       ▼
   POST /v1/dummy/quote/AAPL?fail=1   (x-pact-agent: <agent pubkey>, ed25519 sig)
       │
       ▼  market-proxy : packages/market-proxy/src/routes/proxy.ts
       │   1. registry.get("dummy")  → EndpointRow {flatPremiumLamports:1000,
       │      slaLatencyMs:2000, imputedCostLamports:10000, upstreamBase:"https://dummy.pactnetwork.io", ...}
       │   2. handlerRegistry["dummy"].buildRequest → rewrite to https://dummy.pactnetwork.io/...,
       │      strip pact_wallet/demo_breach, strip caller Authorization/Cookie
       │   3. handlerRegistry["dummy"].isInsurableMethod → true
       │   4. classifierRegistry["dummy"] → marketDefaultClassifier (status-based)
       │   5. wrapFetch({...}) ──────────────────────────────────────────────┐
       ▼                                                                     │
   @pact-network/wrap : packages/wrap/src/wrapFetch.ts                        │
       │   a. balanceCheck.check(agentPubkey, premium=1000)  → 402 if the     │
       │      agent's USDC ATA balance < 1000 OR delegated allowance to the   │
       │      SettlementAuthority PDA < 1000. (The agent must have run        │
       │      `pact approve` once.)                                           │
       │   b. t_start = now()                                                 │
       │   c. fetch("https://dummy.pactnetwork.io/quote/AAPL?fail=1")  → 503  │
       │   d. t_end = now(); latencyMs = t_end - t_start                      │
       │   e. classifier.classify({response: 503, latencyMs, endpointConfig}) │
       │      defaultClassifier: status 503 ∈ [500,599] →                     │
       │        { outcome: "server_error", premium: 1000, refund: 10000 }     │
       │   f. sink.publish(SettlementEvent{callId, agentPubkey, endpointSlug:"dummy",
       │        premiumLamports:"1000", refundLamports:"10000", latencyMs,
       │        outcome:"server_error", ts}) — FIRE AND FORGET (Pub/Sub topic)│
       │   g. return Response(503 body) + X-Pact-* headers:                   │
       │        X-Pact-Call-Id, X-Pact-Outcome: server_error,                 │
       │        X-Pact-Premium: 1000, X-Pact-Refund: 10000,                   │
       │        X-Pact-Pool: dummy, X-Pact-Settlement-Pending: true           │
       ▼                                                                      │
   agent sees: HTTP 503 (the real upstream body) + the X-Pact-* headers.      │
   The pact CLI surfaces these as meta on the call result.                    │
                                                                              │
   ── async, seconds later ───────────────────────────────────────────────── │
                                                                              ▼
   settler : packages/settler/  (NestJS, on Cloud Run)
       consumer  ← Pub/Sub subscription delivers the SettlementEvent
       batcher   batches up to MAX_BATCH_SIZE (50) events / a few seconds
       submitter : packages/settler/src/submitter/submitter.service.ts
         - per unique slug "dummy": getAccountInfo(EndpointConfig PDA) +
           getAccountInfo(CoveragePool PDA) → snapshot {feeRecipients, poolVault}
         - build one ChainSettlementEvent per message:
             callId(16B), agentOwner, agentAta = ATA(agentOwner, USDC mint),
             endpointConfig PDA, coveragePool PDA, poolVault,
             slug = "dummy"(16B padded), premiumLamports=1000, refundLamports=10000,
             latencyMs, breach = (outcome != "ok") = true, timestamp(unix s),
             feeRecipientAtas = [Treasury.usdc_vault]  (1 entry, EndpointConfig order)
         - buildSettleBatchIx({ programId, settler=SettlementAuthority.signer,
             settlementAuthority PDA, protocolConfig PDA, events, callRecordPdas })
         - prepend ComputeBudget setComputeUnitLimit(1_000_000) + setComputeUnitPrice(5_000)
         - sendAndConfirmTransaction signed by [settlerSigner]   ← THE settle_batch TX
       indexer-pusher → POST the SettlementOutcome to the indexer
       ack the Pub/Sub messages
       ▼
   on-chain : settle_batch handler (packages/program/.../instructions/settle_batch.rs)
       - reads ProtocolConfig.paused at fixed account index 4 → if !0, reject whole batch (6032)
       - per event:
         * init CallRecord PDA [b"call", call_id]  (dedup sentinel; if it already
           exists the batch poison-loops — submitter has idempotency short-circuit)
         * SPL Token Transfer (delegate = SettlementAuthority PDA, invoke_signed):
           1000 base units  agent USDC ATA → ... split:
             - Treasury fee: floor(1000 * 1000bps / 10_000) = 100 base units → Treasury.usdc_vault
             - residual 900 base units → CoveragePool USDC vault (the pool keeps the rest of the premium)
         * because breach == true: SPL Token Transfer  refund_lamports = 10_000 base units
           CoveragePool USDC vault → agent USDC ATA, CLAMPED by the endpoint's
           hourly exposure_cap_per_hour_lamports (1_000_000) — first ~100 refunds/hr
           go through in full, then clamp. CallRecord.settlement_status records
           Settled / PoolDepleted / ExposureCapClamped, and actual_refund_lamports
           records what actually moved.
       ▼
   indexer : packages/indexer/  → Postgres
       - Call row {callId, agentPubkey, endpointSlug:"dummy", premiumLamports:1000,
         refundLamports:10000, breach:true, breachReason, source, signature = settle_batch tx}
       - SettlementRecipientShare {recipientKind:Treasury, amount:100}
       - PoolState("dummy") deltas, Agent counters, RecipientEarnings
```

### A.1 Who debits the premium, when, from where

| step | who | what | from → to |
|---|---|---|---|
| request time | `wrapFetch` (`balanceCheck`) | *preflight only* — verifies the agent's USDC ATA balance ≥ premium AND its delegated allowance to the SettlementAuthority PDA ≥ premium. No money moves. If not eligible → HTTP 402. | — |
| ~seconds later | on-chain `settle_batch` (SPL Token Transfer, delegate = SettlementAuthority PDA, `invoke_signed`) | the actual premium debit: **1000 base units** ($0.001) | agent's USDC ATA → split: 100 base units → Treasury USDC vault (the 10% fee), 900 base units → the `dummy` CoveragePool USDC vault |

So: the premium is debited *on-chain by the settler*, not by the proxy, and not at request time. The proxy only does a non-binding eligibility check. The agent's funds are guaranteed available because they ran `pact approve` (SPL Token `Approve` → delegate = SettlementAuthority PDA, allowance ≥ N premiums) and the balance check ran before the upstream call.

### A.2 How the 503 becomes `server_error`

`pact-dummy-upstream`'s `GET /quote/AAPL?fail=1` responds **HTTP 503**. In `wrapFetch`:

1. `fetchImpl(upstreamUrl)` returns a `Response` with `status === 503` (not a thrown network error).
2. `classifier.classify({ response, latencyMs, endpointConfig })` → for `dummy` this is `marketDefaultClassifier` (= wrap's `defaultClassifier`, since `dummy` returns plain HTTP, not JSON-RPC).
3. `defaultClassifier`: `status >= 500 && status <= 599` → `{ outcome: "server_error", premium: flat_premium_lamports = 1000n, refund: imputed_cost_lamports = 10000n }`.
4. `wrapFetch` publishes a `SettlementEvent` with `premiumLamports: "1000"`, `refundLamports: "10000"`, `outcome: "server_error"` and attaches `X-Pact-Outcome: server_error`, `X-Pact-Premium: 1000`, `X-Pact-Refund: 10000` to the response it hands back to the agent.

Other dummy knobs and their classifier outcomes (all via `defaultClassifier`):

| query | upstream status | classifier outcome | premium | refund |
|---|---|---|---|---|
| (none) | 200 (fast) | `ok` | 1000 | 0 |
| `?latency=2500` | 200, but +2500ms | `latency_breach` (2500 > slaLatencyMs 2000) | 1000 | 10000 |
| `?fail=1` | 503 | `server_error` | 1000 | 10000 |
| `?status=500` | 500 | `server_error` | 1000 | 10000 |
| `?status=404` | 404 | `client_error` | 0 | 0 |
| `?x402=1` | 402 | `client_error` (4xx → caller's fault under default SLA) | 0 | 0 |
| upstream unreachable | — (fetch throws) | `network_error` | 1000 | 10000 |

(Note on net economics: on a covered failure the agent is debited the premium **and** refunded `imputed_cost_lamports`. With the demo values, premium = 1000, refund = 10000, so the agent comes out **+9000 base units ahead** on a covered failure — that's deliberate for the demo so the refund is unmissable. In production the imputed cost is calibrated to the actual cost basis of a failed call; e.g. `helius` ships with premium 1000, imputed 5000.)

### A.3 How the settler builds the `settle_batch`

`packages/settler/src/submitter/submitter.service.ts::submit(batch)`:

1. For each unique slug in the batch (here just `"dummy"`): `getAccountInfo(getEndpointConfigPda(programId, "dummy"))` and `getAccountInfo(getCoveragePoolPda(programId, "dummy"))`, decode → `{ config: {feeRecipientCount:1, feeRecipients:[{kind:Treasury, destination:<EndpointConfig copy of Treasury vault>, bps:1000}]}, endpointConfigPda, coveragePool, poolVault }`. Cached 60s.
2. For each message, build a `ChainSettlementEvent`:
   - `callId` = the 16-byte call id parsed from the wrap event's `callId` (UUID or 32-hex).
   - `agentOwner` = `new PublicKey(event.agentPubkey)`; `agentAta` = `deriveAssociatedTokenAccount(agentOwner, usdcMint)`.
   - `endpointConfig`, `coveragePool`, `poolVault` from the snapshot.
   - `slug` = `slugBytes("dummy")` (16-byte NUL-padded).
   - `premiumLamports` = `1000n`, `refundLamports` = `10000n`, `latencyMs`, `breach` = `outcome !== "ok"` = `true`, `timestamp` = unix seconds.
   - `feeRecipientAtas` = `[Treasury.usdc_vault]` — in EndpointConfig order; Treasury entries map to the singleton Treasury USDC vault (read once at boot from the Treasury PDA), Affiliate* entries would use their stored destination directly. `dummy` has only the one Treasury recipient.
3. `callRecordPdas[i]` = `getCallRecordPda(programId, callId)[0]`.
4. `buildSettleBatchIx({ programId, settler = SettlementAuthority.signer pubkey, settlementAuthority PDA, protocolConfig PDA (fixed account index 4 — the on-chain kill-switch read), events, callRecordPdas })`. Account layout per event: `[callRecord PDA (w), coveragePool PDA (w), coveragePool USDC vault (w), endpointConfig PDA (w), agent USDC ATA (w), …feeRecipientAtas (w, EndpointConfig order)]`.
5. Prepend `ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })` + `setComputeUnitPrice({ microLamports: 5_000 })`.
6. `sendAndConfirmTransaction(conn, tx, [settlerSignerKeypair], { commitment: "confirmed" })` with a retry + idempotency short-circuit (if `callRecordPdas[0]` already exists on-chain, reuse the prior signature instead of resubmitting and poison-looping the batch).

That confirmed transaction is **the `settle_batch` tx**.

### A.4 Where the refund lands; what the agent sees

- **Refund destination**: the agent's own USDC ATA (`deriveAssociatedTokenAccount(agentOwner, USDC mint)`). The on-chain handler, because `breach == true`, does a second SPL Token Transfer of `refund_lamports = 10_000` base units **from the `dummy` CoveragePool USDC vault → agent USDC ATA**, clamped by the endpoint's hourly `exposure_cap_per_hour_lamports` (1_000_000). The `CallRecord` records `settlement_status` (`Settled` / `PoolDepleted` / `ExposureCapClamped`) and `actual_refund_lamports`.
- **What the agent sees at request time** (synchronous, from `wrapFetch`'s response headers): `X-Pact-Call-Id`, `X-Pact-Outcome: server_error`, `X-Pact-Premium: 1000`, `X-Pact-Refund: 10000`, `X-Pact-Pool: dummy`, `X-Pact-Settlement-Pending: true`. The pact CLI surfaces these as `meta.premium_usdc` (= 0.001), `meta.refund_usdc` (= 0.010), `meta.outcome`, `meta.call_id`, `meta.settlement_pending: true`.
- **What the agent sees after settlement** (poll `GET /v1/calls/<callId>` on the indexer): the `Call` row with `signature` = the `settle_batch` tx, `breach: true`, `refundLamports: 10000`, plus the per-recipient `SettlementRecipientShare` rows. The CLI surfaces `meta.tx_signature` once the call is settled. `meta.premium_usdc` and `meta.tx_signature` together are the receipt.

→ **Solscan link to the `settle_batch` tx**: `https://solscan.io/tx/<signature>` (devnet: `https://solscan.io/tx/<signature>?cluster=devnet`). That single transaction shows: the 1000-base-unit premium pull from the agent ATA, the 100→Treasury / 900→pool split, and (on a breach) the 10000-base-unit refund pool→agent — the whole coverage event in one tx.

### A.5 Operator runbook — make the `dummy` demo live

Prereqs: the protocol is already initialised on the target cluster (`init-mainnet.ts` or a devnet equivalent has run `initialize_protocol_config` + `initialize_treasury` + `initialize_settlement_authority`), the `market-proxy` / `settler` / `indexer` are deployed and pointed at that cluster + a shared Postgres, and you have:
- the protocol-authority keypair (`PACT_PRIVATE_KEY`), whose USDC ATA holds ≥ 1.0 USDC on that cluster (create + fund it: `spl-token create-account <USDC mint> --owner <authority>`, then mint/transfer ≥ 1_000_000 base units)
- `PG_URL` for the shared Postgres
- the `market-proxy`'s `ENDPOINTS_RELOAD_TOKEN`
- a demo agent wallet with some USDC + SOL on that cluster

Steps (devnet/staging — **not** mainnet for the MVP):

1. **Deploy the dummy upstream.** Another agent ships `pact-dummy-upstream` at `https://dummy.pactnetwork.io` with routes `GET /health`, `GET /quote/:symbol` (`?fail=1`→503, `?latency=<ms>`, `?status=<n>`, `?x402=1`→402). Sanity: `curl -s https://dummy.pactnetwork.io/health` and `curl -si https://dummy.pactnetwork.io/quote/AAPL?fail=1` (expect 503).

2. **Seed the `Endpoint` Postgres row.**
   ```bash
   # SQL flavour:
   psql "$PG_URL" -f packages/db/seeds/dummy-endpoint.sql
   # or TS flavour:
   PG_URL="$PG_URL" pnpm --filter @pact-network/db exec tsx seeds/dummy-endpoint.ts
   ```
   This sets `slug='dummy'`, `upstreamBase='https://dummy.pactnetwork.io'`, `displayName='Pact Dummy Upstream (demo)'`, `flatPremiumLamports=1000`, `percentBps=0`, `slaLatencyMs=2000`, `imputedCostLamports=10000`, `exposureCapPerHourLamports=1000000`, `paused=false`. (The indexer's `OnChainSyncService` will keep the on-chain-derived columns in step once step 3 lands; `dummy` is also in the indexer's `DEFAULT_UPSTREAM_BASE` map so a chain-first create still gets the right `upstreamBase`.)

3. **Register the endpoint on-chain + fund its coverage pool.**
   ```bash
   # dry run first (prints derived addresses + planned txs, sends nothing):
   PACT_PRIVATE_KEY=~/.config/solana/pact-devnet-authority.json \
   PACT_RPC_URL="https://devnet.helius-rpc.com/?api-key=<key>" \
   PROGRAM_ID=<devnet program id> USDC_MINT=<devnet USDC mint> \
     pnpm exec tsx scripts/dummy-coverage-pool.ts
   # for real:
   PACT_PRIVATE_KEY=... PACT_RPC_URL=... PROGRAM_ID=... USDC_MINT=... \
     pnpm exec tsx scripts/dummy-coverage-pool.ts --confirm
   ```
   This runs `register_endpoint("dummy", flatPremium=1000, percentBps=0, slaMs=2000, imputed=10000, exposureCap/hr=1000000, [Treasury 10%])` — which atomically creates the `EndpointConfig` PDA, the `CoveragePool` PDA, and pre-allocates + binds the pool's 165-byte USDC vault — then `top_up_coverage_pool("dummy", 1_000_000)` (1.00 USDC) from the authority's USDC ATA into that vault. Verify: `solana account <coveragePool PDA> --url <rpc>` (endpoint_slug `dummy`, current_balance > 0) and `solana account <endpointConfig PDA>` (paused = 0, flat_premium_lamports = 1000).

4. **Reload the market-proxy registry.**
   ```bash
   curl -X POST https://<market-proxy-host>/admin/reload-endpoints \
     -H "Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN"
   # → {"ok":true,"endpoints_loaded":6}
   ```
   (Or just wait — the in-process 60s TTL refreshes on its own.) Also confirm the discovery payload now lists it: `curl -s https://<market-proxy-host>/.well-known/endpoints | jq '.endpoints[] | select(.slug=="dummy")'` (the `dummy` → `dummy.pactnetwork.io` hostname mapping is in `packages/market-proxy/src/lib/hostnames.ts`).

5. **`pact approve` an allowance from the demo agent wallet.**
   ```bash
   pact approve --amount 1.0   # SPL Token Approve → delegate = SettlementAuthority PDA, allowance = 1.0 USDC
   ```
   (The agent wallet also needs a few cents of USDC on that cluster + SOL for the approve tx.)

6. **Run the call.**
   ```bash
   pact https://dummy.pactnetwork.io/quote/AAPL?fail=1
   ```
   Expect: HTTP 503 body from the upstream, plus the pact CLI's coverage line showing `outcome=server_error premium=0.001 refund=0.010 pool=dummy settlement_pending=true`. Seconds later, `pact calls <callId>` (or `GET /v1/calls/<callId>` on the indexer) shows the settled `Call` with `signature` = the `settle_batch` tx → open `https://solscan.io/tx/<signature>?cluster=devnet`.

   For the latency-breach variant: `pact https://dummy.pactnetwork.io/quote/AAPL?latency=2500` (200 from the upstream, but `latency_breach` since 2500 > 2000ms SLA → same 0.010 refund). For the happy path: `pact https://dummy.pactnetwork.io/quote/AAPL` (200, fast, `ok`, premium 0.001, no refund).

---

## Part B — `pact pay` facilitator (`facilitator.pact.network`) — design

Today `pact pay <args>` (`packages/cli/src/cmd/pay.ts`) shells out to `pay` (solana-foundation/pay), classifies the result, and prints honest `(facilitator not yet enabled)` / `(refund settlement available via facilitator.pact.network — coming soon)` lines. There is no facilitator. This section designs it.

### B.1 Decision (i): how does pay.sh's settlement relate to the facilitator?

**Chosen model: side-call (facilitator-as-receipt-registrar), NOT facilitator-as-payee.**

`pact pay` keeps `pay` doing exactly what it does today (parse the x402/MPP challenge, sign the payment, retry). **After `pay` exits**, `pact pay` makes a side-call to `facilitator.pact.network`:

```
POST https://facilitator.pact.network/v1/coverage/register
{
  "agent_pubkey": "<the agent's Solana pubkey>",
  "x402_receipt": {                    // extracted from pay's output / the 402 challenge
    "payee": "<merchant pubkey>",
    "asset": "<mint>",
    "amount": "<base units>",
    "tx_signature": "<the payment tx pay submitted>",
    "resource": "<the URL that was paid for>",
    "scheme": "x402" | "mpp"
  },
  "classifier_verdict": {              // computed by pact-cli's existing pay-classifier
    "outcome": "success" | "server_error" | "client_error" | "payment_failed",
    "upstream_status": 503,
    "latency_ms": 1840,
    "reason": "..."
  },
  "signature": "<ed25519 over the canonical payload, by the agent key>"   // same auth pattern as the gateway's verify-signature
}
→ 200 { "coverage_id": "...", "covered": true, "premium_base_units": "...", "refund_base_units": "...", "settlement_pending": true }
   or  200 { "covered": false, "reason": "no_pool_for_payee" | "below_min" | "not_covered_outcome" }
```

The facilitator records the receipt + verdict, decides coverage, charges the premium and (on a covered failure) issues the refund **on-chain via the same `settle_batch` machinery the gateway path uses** (see B.3), then `pact pay` prints a real coverage line instead of `(coming soon)`.

**Why side-call, not facilitator-as-payee:**

1. **Don't break pay.sh's trust model.** x402/MPP is "client pays the merchant directly, atomically, with the resource handed back in the 402→200 dance." Inserting `facilitator.pact.network` as an *intermediary payee* (client pays facilitator, facilitator forwards to merchant minus/plus premium) means: (a) the merchant now has to trust + be configured to accept payment from the facilitator, not the agent — a massive adoption ask; (b) the facilitator becomes a custodian of in-flight funds (regulatory + operational liability); (c) it adds a hop that can fail *after* the agent has paid but *before* the merchant is paid — exactly the kind of failure Pact is supposed to *insure against*, now created by Pact itself. The strategy doc's framing is "chargebacks for x402" — a chargeback is an *after-the-fact* settlement on a payment that already happened directly, not a re-routing of the payment rail. Side-call matches that.
2. **It's incremental and opt-out-able.** A side-call that fails (facilitator down, network blip) degrades to *exactly today's behaviour* — `pay` already settled the payment directly, the agent got their resource, and `pact pay` just can't print a coverage line. With facilitator-as-payee, a facilitator outage means the agent can't pay the merchant at all.
3. **It mirrors the gateway path's already-proven shape.** The gateway path is: call happens directly (proxy → upstream), then an async settlement event drives an on-chain `settle_batch`. The side-call model is the same: payment happens directly (pay → merchant), then a registration call drives an on-chain `settle_batch`. Same `settler`, same `settle_batch`, same `CoveragePool` model, same `indexer` — only the *source* of the settlement event changes.
4. **Latency.** Facilitator-as-payee would put the facilitator on the critical path of every paid call (extra round-trip, extra signature, extra failure mode). Side-call happens *after* the agent already has their resource — it can be best-effort and even retried in the background.

The one thing the side-call model gives up: it can't *withhold* the premium and only release it on success — the premium is charged after the fact (same as the gateway path's `settle_batch`, which pulls the premium from the agent's pre-approved allowance seconds later). That's fine; it's the established Pact pattern, and `pact pay`'s mainnet gate + the agent's `pact approve` allowance cap bound the exposure.

### B.2 Decision (ii): on-chain refund-funding source

**Chosen: a per-payee/per-resource Pact-subsidised capped launch pool — the strategy doc's deliverable #4 — for the MVP, with the agent-allowance model as the *premium* source (not the refund source), exactly like the gateway path.**

There are two distinct money flows; keep them separate:

- **Premium (agent → Pact/pool/treasury):** funded from the **agent's own `pact approve` allowance** (SPL Token `Approve` → delegate = SettlementAuthority PDA), identical to the gateway path. The `settle_batch` for a pay.sh-covered call pulls the premium from the agent's USDC ATA. Requires the agent to have approved — `pact pay` should print a clear `(coverage available — run \`pact approve\` to enable refunds)` line when no allowance is detected, and still register the receipt so coverage can be retro-activated. **If the agent has not approved, the call is uncovered** (no premium charged, no refund) — the side-call still records it for analytics.
- **Refund (pool → agent, on a covered failure):** funded from a **Pact-subsidised, per-coverage-target, capped launch pool** — a `CoveragePool` PDA keyed by a synthetic slug for the pay.sh-covered resource (e.g. `pay:<short-hash-of-payee+resource>`), pre-funded by Pact (small, e.g. tens of USDC) with a tight `exposure_cap_per_hour_lamports`. This is exactly the gateway path's pool model, just with a slug that names a pay.sh resource instead of a wrapped provider. The premium that the agent pays (minus the Treasury fee) flows *into* this pool, so over time the pool becomes self-sustaining; Pact's subsidy is just the bootstrap float.

Why not "fund refunds from the agent's allowance too": the agent's allowance is sized for *premiums* (cents), not *refunds* (the imputed cost of a failed paid call, which could be the full payment amount — dollars). And conceptually a refund the agent funds themselves isn't a refund. The pool *is* the insurance reservoir; that's the whole protocol. Why capped + per-target: caps the protocol's launch-phase exposure to a known number, and per-target pools mean a single flaky merchant can't drain coverage for everyone.

For the *very first* MVP cut, to avoid a combinatorial explosion of synthetic-slug pools, start with **one shared `pay:default` launch pool** (slug `pay-default`, ≤ 16 chars) covering all pay.sh-covered calls, with a conservative hourly cap. Split into per-target pools once volume justifies it (the on-chain model already supports it — it's just more `register_endpoint` calls).

> **Demo-honesty note — key alignment for the "net cost $0.000 on a failed call" story.**
> The pitch is: on a covered failure the agent is debited the premium *and* refunded
> the call's imputed cost, so a failed paid call costs the agent ≈$0.000 net. For
> that story to be *honest* in a live demo, the wallet the premium is debited from
> (and the wallet the refund returns to) must be the **same key that actually paid
> the merchant** — i.e. `pay`'s Keychain account, the one `pay` settles the x402/MPP
> payment from. But the side-call sends the **pact wallet** pubkey as `agent` (it's
> the one with the `pact approve` allowance and the one the gateway-path auth uses),
> which is a *different* key than `pay`'s by default. So out of the box: the premium
> is debited from the pact wallet and the refund returns to the pact wallet, **not**
> to where the USDC actually left. No code change fixes this — the CLI correctly
> sends the allowance-holding wallet as `agent`. The **demo setup** just has to align
> the keys: run `pact approve` from the *same* key `pay` uses to settle (point
> `pact init` / `PACT_PRIVATE_KEY` at `pay`'s Keychain key, or vice versa). Then the
> premium debit, the refund credit, and the merchant payment all hit one wallet and
> the "net $0.000" claim holds end-to-end. (A future option (b): have `pact pay`
> extract `pay`'s `signer=…` pubkey and send it as a separate `paymentSignerPubkey`
> so the facilitator could cross-check / route — out of scope here.)

### B.3 What new code is needed, by package

#### `packages/cli` — `pact pay` → register

- New `packages/cli/src/lib/facilitator.ts`: `registerCoverage({ agentKeypair, x402Receipt, verdict, facilitatorUrl })` — builds the canonical payload, signs it (ed25519, same scheme as `transport.ts::buildSignaturePayload`), POSTs to `facilitator.pact.network/v1/coverage/register`, returns the coverage decision. Best-effort: timeouts/5xx are swallowed (logged), never fail the `pact pay` command.
- New `packages/cli/src/lib/x402-receipt.ts`: parse `pay`'s stdout/stderr (it already prints `Paying...` / `Payment signed...` lines — see `pay-shell.ts::withVerboseFlag`) + the original URL into an `X402Receipt { payee, asset, amount, txSignature, resource, scheme }`. Reuses the existing `pay-classifier.ts` for the verdict.
- `packages/cli/src/cmd/pay.ts`: after `runPay(...)` and `classifyPayResult(...)`, if not in the closed-mainnet gate and the agent key is resolvable, call `registerCoverage(...)`; replace the `(facilitator not yet enabled)` / `(coming soon)` lines in `writePactSummary` with the real coverage decision (`premium 0.00X / refund 0.0XX (coverage <id>, settlement pending)` or `(uncovered: <reason>)` or `(coverage available — run \`pact approve\`)`).
- Tests: `pay.test.ts` gains cases for "facilitator returns covered", "facilitator returns uncovered", "facilitator unreachable → degrades to today's lines", "no allowance → prints the approve hint".
- *PR-sized chunk #B1.*

#### `packages/facilitator/` — new NestJS service `facilitator.pact.network`

- `POST /v1/coverage/register` — verifies the ed25519 signature (reuse `ops.service`'s pattern), validates the receipt (the `tx_signature` is a real, confirmed payment to the claimed `payee` for the claimed `amount` — `getTransaction` + parse), maps `(payee, resource)` → a coverage target / synthetic slug (config table, default `pay-default`), checks the agent has a sufficient `pact approve` allowance to the SettlementAuthority PDA (reuse `getAgentInsurableState`), computes the premium (a small flat or % of the payment, per the target's config) and the imputed refund (the target's `imputed_cost_lamports`), persists a `CoveredPayCall` row, and publishes a `SettlementEvent` onto the **same Pub/Sub topic the gateway path uses** — with `endpointSlug` = the synthetic slug (`pay-default`), `source` = `pay.sh`, plus `agentPubkey`, `premiumLamports`, `refundLamports` (0 unless the verdict outcome is a covered failure), `latencyMs`, `outcome`, `ts`, and `callId` derived from the payment tx signature (16 bytes of its hash → deterministic dedup).
- `GET /v1/coverage/:coverageId` — status (mirrors the gateway's `GET /v1/calls/:id`): the `CoveredPayCall` row + the `settle_batch` signature once settled.
- `GET /.well-known/pay-coverage` — discovery payload the CLI could fetch to know which payees/resources are covered (analogous to `/.well-known/endpoints`).
- Health, metrics, the standard Cloud Run shape.
- Tests + the deploy manifest in `deploy/`.
- *PR-sized chunks #B2 (skeleton + register endpoint + signature verify), #B3 (receipt verification against chain), #B4 (Pub/Sub publish + status endpoint + discovery).*

#### `indexer` — record pay.sh-covered calls

- The `Call.source` column already exists (`VARCHAR(32)`) — pay.sh-covered calls land with `source = "pay.sh"`. The `Endpoint` table needs the synthetic-slug rows (`pay-default`, etc.) — seed them the same way as `dummy` (a `packages/db/seeds/pay-default-endpoint.sql` + matching on-chain `register_endpoint`).
- `OnChainSyncService` already syncs every `EndpointConfig` PDA — the synthetic-slug endpoints come along for free once registered on-chain. Add their `upstreamBase` to `DEFAULT_UPSTREAM_BASE` as a sentinel like `https://facilitator.pact.network/pay-default` (it's never actually fetched — pay.sh-covered calls don't proxy through anything — but the column is non-nullable and the proxy's `new URL(...)` would throw on `""`).
- New `CoveredPayCall` model in the Prisma schema (or reuse `Call` with `source = "pay.sh"` and a nullable `payee`/`resource` — leaner; do that): add nullable `payee VARCHAR(44)` and `resource TEXT` to `Call`, populated only for pay.sh-covered calls. A migration.
- `EventsService.ingest` already handles arbitrary slugs (lazy-create) — no change needed beyond the schema columns.
- *PR-sized chunk #B5 (schema migration + synthetic-slug seeds + DEFAULT_UPSTREAM_BASE entry).*

#### `settler` — include pay.sh refunds

- **Likely zero on-chain-shape change.** The settler consumes `SettlementEvent`s off the Pub/Sub topic and resolves each event's slug → `EndpointConfig` + `CoveragePool` on-chain. A pay.sh-covered event with `endpointSlug = "pay-default"` resolves the `pay-default` `EndpointConfig`/`CoveragePool` exactly like `dummy` — `settle_batch` pulls the premium from the agent ATA, splits to Treasury + pool, and (on a breach) refunds `imputed_cost_lamports` from the `pay-default` pool. The only thing to confirm: the settler doesn't hard-code the set of valid slugs anywhere (it doesn't — it's all dynamic via PDA derivation).
- Add the synthetic-slug pools to whatever pool-balance monitoring/alerting the settler has, so a depleted `pay-default` pool pages someone.
- *PR-sized chunk #B6 (monitoring only) — fold into #B5 if trivial.*

#### `program` — new instruction / event types?

- **None for the MVP.** The existing model is sufficient: a pay.sh-covered call is just a `settle_batch` event against a `CoveragePool` whose slug happens to name a pay.sh coverage target. `register_endpoint` + `top_up_coverage_pool` + `settle_batch` already do everything needed. The `CallRecord` dedup PDA, the exposure cap, the fee fan-out, the `settlement_status` discriminant — all reused as-is.
- *Future (post-MVP, optional):* if pay.sh coverage volume + the per-target-pool explosion makes the "one `register_endpoint` per coverage target" model unwieldy, a V2 could add a generic `CoveragePool` not tied to an `EndpointConfig` (decouple the pool from the endpoint), or a "claim against a shared pool with a per-claim cap" instruction. Not needed to ship the MVP.

### B.4 Ordered task breakdown (PR-sized)

1. **#B5** — schema migration: add `payee`/`resource` nullable columns to `Call`; add `pay-default` to the indexer's `DEFAULT_UPSTREAM_BASE`; ship `packages/db/seeds/pay-default-endpoint.sql` + `.ts` (mirror `dummy-endpoint`). *(Lands the data layer first so everything else has a target.)*
2. **#B7** — on-chain bootstrap script `scripts/pay-coverage-pool.ts` (mirror `dummy-coverage-pool.ts`): `register_endpoint("pay-default", <conservative config>)` + `top_up_coverage_pool("pay-default", <small Pact subsidy>)`. Document, don't run against mainnet.
3. **#B2** — `packages/facilitator/` skeleton (NestJS, health, metrics, Cloud Run shape) + `POST /v1/coverage/register` with ed25519 signature verification + a stub coverage decision (always `covered: false, reason: "not_yet_enabled"`). Tests.
4. **#B3** — facilitator: receipt verification (validate `tx_signature` is a confirmed payment to `payee` for `amount` via `getTransaction`), `(payee, resource)` → slug mapping (config table, default `pay-default`), agent-allowance check via `getAgentInsurableState`, premium/refund computation from the target's config.
5. **#B4** — facilitator: publish `SettlementEvent` to the shared Pub/Sub topic with `source: "pay.sh"`; `GET /v1/coverage/:id`; `GET /.well-known/pay-coverage`. Now an end-to-end pay.sh-covered call actually settles on-chain (verify against devnet).
6. **#B1** — `packages/cli`: `facilitator.ts` + `x402-receipt.ts`; wire `pact pay` to call `registerCoverage` after `pay` exits; replace the `(coming soon)` summary lines with the real coverage decision. Tests for covered / uncovered / facilitator-unreachable / no-allowance. *(CLI last so it lights up a backend that already works.)*
7. **#B6** — add the `pay-default` pool to the settler's pool-balance monitoring/alerting. *(Fold into #B5 if trivial.)*
8. *(Post-MVP, optional)* per-payee/per-resource pools instead of the shared `pay-default` pool; a V2 program instruction decoupling `CoveragePool` from `EndpointConfig` if the per-target model gets unwieldy.
