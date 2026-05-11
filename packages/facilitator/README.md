# `@pact-network/facilitator` — `facilitator.pact.network`

The **pay.sh / x402 premium-coverage register service**. It brings Pact Network
coverage (premiums + refunds) to the `pact pay` (pay.sh) path using the
**side-call / receipt-registrar** model — *not* facilitator-as-payee.

See `docs/premium-coverage-mvp.md` (Part B) for the full design and the
reasoning behind the routing model. This README is the operational quick-ref.

## Model

```
agent (pact pay)                                       facilitator.pact.network                  Solana
   │  pact pay <args>
   │  → `pay` parses the x402/MPP challenge, signs the payment, retries.
   │  → payment settles DIRECTLY with the merchant (pay → merchant). Agent gets the resource.
   │  → `pact pay` classifies the result (pay-classifier), then side-calls:
   ▼
POST /v1/coverage/register
  body  = { agent, payee, resource, scheme, paymentSignature, amountBaseUnits, asset, verdict, latencyMs }
  headers = x-pact-agent / x-pact-timestamp / x-pact-nonce / x-pact-signature   (ed25519 over the
            canonical payload — SAME scheme as the gateway, see verify-signature.ts)
   │
   ▼  facilitator:
   │   1. verify the ed25519 envelope (replay-protected, ±30s skew)            [middleware]
   │   2. cross-check x-pact-agent == body.agent
   │   3. verify `paymentSignature` on-chain: a confirmed tx that moved
   │      ≥ amountBaseUnits of `asset` (must be the network USDC mint) into an
   │      account owned by `payee`  (pre/post token-balance delta — robust to
   │      transfer / transferChecked / CPI'd transfers)
   │   4. map (payee, resource) → coverage-pool slug   (MVP: always `pay-default`)
   │   5. read the pool's flat premium / imputed refund from Postgres (env fallback)
   │   6. check the agent's `pact approve` allowance covers the premium
   │   7. compute premium + (possibly 0) refund from the verdict
   │   8. publish a SettlementEvent onto the SAME Pub/Sub topic the market-proxy
   │      uses, with source: "pay.sh", endpointSlug: "pay-default", callId =
   │      deterministic hash of (payee, resource, paymentSignature)             ──┐
   │   9. respond { coverageId, status, premiumBaseUnits, refundBaseUnits, reason } │
   ▼                                                                               │
   ── async, seconds later ─────────────────────────────────────────────────────── │
                                                                                   ▼
   settler (packages/settler/, unchanged) ← Pub/Sub subscription
     → resolves slug "pay-default" → EndpointConfig + CoveragePool PDAs
     → buildSettleBatchIx → settle_batch on-chain:
         premium pulled from agent USDC ATA (delegate = SettlementAuthority PDA),
         split 10% → Treasury / residual → pay-default pool vault;
         on a covered breach: refund (= imputed_cost) pool vault → agent USDC ATA,
         clamped by the pool's hourly exposure cap.
     → POSTs the SettlementOutcome to the indexer → Postgres `Call` row
       (source = "pay.sh", payee, resource).
```

## Routes

| method | path | purpose |
|---|---|---|
| `POST` | `/v1/coverage/register` | register a pay.sh payment receipt + verdict; returns the coverage decision. Auth: ed25519 envelope (required). |
| `GET`  | `/v1/coverage/:id` | status of a registered coverage record (`settlement_pending` until the settler's `settle_batch` lands + the indexer ingests it; then `settled` with the tx signature). |
| `GET`  | `/.well-known/pay-coverage` | facilitator metadata: supported schemes, the `pay-default` pool, premium/refund rates, hourly exposure cap, **subsidised-launch disclosure**. |
| `GET`  | `/health` | liveness. |

### `POST /v1/coverage/register` — request

```jsonc
{
  "agent": "<bs58 Solana pubkey>",          // MUST equal the x-pact-agent header
  "payee": "<bs58 merchant wallet pubkey>",  // OWNER of the receiving token account
  "resource": "<the URL/resource paid for>", // non-empty, ≤2048 chars
  "scheme": "x402" | "mpp",
  "paymentSignature": "<bs58 Solana tx signature `pay` submitted>",
  "amountBaseUnits": "<integer string — USDC base units the agent paid>",
  "asset": "<bs58 USDC mint — must match the facilitator's configured USDC_MINT>",
  "verdict": "success" | "ok" | "latency_breach" | "server_error" | "network_error" | "client_error" | "payment_failed",
  "latencyMs": 1840                          // optional; defaults to 0
  // extra fields (upstreamStatus, reason, ...) are accepted and ignored
}
```

Headers (same as the gateway path — see `packages/cli/src/lib/transport.ts`):
`x-pact-agent`, `x-pact-timestamp` (ms since epoch), `x-pact-nonce` (bs58),
`x-pact-signature` (bs58 ed25519 sig over `v1\nPOST\n/v1/coverage/register\n<ts>\n<nonce>\n<sha256(body)hex>`).
(`x-pact-project` is **not** required here.)

### `POST /v1/coverage/register` — response (always HTTP 200 on a well-formed, authenticated, payment-verified request)

```jsonc
{
  "coverageId": "<UUIDv4-shaped, deterministic from the payment>",
  "status": "settlement_pending" | "uncovered",
  "premiumBaseUnits": "<integer string>",       // 0 when uncovered
  "refundBaseUnits": "<integer string>",        // on a covered breach: == amountBaseUnits, capped at the pool's
                                                //   per-call ceiling; 0 otherwise. (And clamped further on-chain by
                                                //   the pool's hourly exposure cap.) Always <= amountBaseUnits.
  "reason": null | "no_allowance" | "insufficient_balance" | "allowance_check_unavailable"
            | "not_covered_outcome" | "pool_paused",
  // present only when status == "settlement_pending":
  "poolSlug": "pay-default",
  "outcome": "ok" | "latency_breach" | "server_error" | "network_error",
  "observedPaymentBaseUnits": "<integer string — what chain says the payee received>"
}
```

On a malformed / unauthenticated / payment-unverifiable request:
HTTP 400 / 401 / 422 with `{ "coverageId": null, "status": "rejected", "reason": "...", "code": "..." }`.

`coverageId` is deterministic — re-registering the same payment yields the same
id (idempotent; the on-chain `CallRecord` PDA dedups it too).

## Env

| var | required | meaning |
|---|---|---|
| `PG_URL` | yes | the indexer's Postgres (for `GET /v1/coverage/:id` + the `pay-default` Endpoint config). |
| `RPC_URL` | yes | Solana JSON-RPC (verify the payment tx + read the agent's USDC ATA). |
| `PROGRAM_ID` | yes | V1 program id (kept for parity with the other services). |
| `USDC_MINT` | yes | USDC mint for this network. `asset` in the request must match. |
| `PUBSUB_PROJECT` | yes | GCP project. |
| `PUBSUB_TOPIC` | yes | **the SAME settlement topic the market-proxy publishes to** (the existing settler subscribes to it). |
| `PAY_DEFAULT_SLUG` | no (`pay-default`) | synthetic coverage-pool slug for pay.sh-covered calls (≤16 chars). |
| `PAY_DEFAULT_FLAT_PREMIUM_LAMPORTS` | no (`1000`) | fallback flat premium before the `pay-default` Endpoint row exists. |
| `PAY_DEFAULT_IMPUTED_COST_LAMPORTS` | no (`1000000`) | fallback per-call refund ceiling ($1.00). On a covered breach the refund = `amountBaseUnits` capped at this. |
| `PAY_DEFAULT_SLA_LATENCY_MS` | no (`10000`) | advertised SLA (metadata; the CLI's verdict is authoritative). |
| `PAY_DEFAULT_EXPOSURE_CAP_PER_HOUR_LAMPORTS` | no (`5000000`) | advertised hourly cap (enforced on-chain by `settle_batch`). |
| `PORT` | no (`8080`) | listen port. |

## Build / test

```bash
pnpm install
pnpm --filter @pact-network/facilitator build
pnpm --filter @pact-network/facilitator test
pnpm --filter @pact-network/facilitator typecheck
docker build -f packages/facilitator/Dockerfile .
```

## Deploy

See `docs/facilitator-deploy.md` — build → push to Artifact Registry → deploy to
Cloud Run → map `facilitator.pact.network` → DNS CNAME → bootstrap the
`pay-default` coverage pool (`scripts/pay-default-bootstrap.ts`) → verify.

## Related

- `docs/premium-coverage-mvp.md` — the design (Part B is this service).
- `packages/market-proxy/` — the gateway path (`api.pactnetwork.io/v1/<slug>/*`); this service mirrors its conventions.
- `packages/settler/` — consumes the shared Pub/Sub topic and drives `settle_batch`. Unchanged except a one-line `source` propagation in `indexer-pusher.service.ts`.
- `scripts/pay-default-bootstrap.ts` — registers the `pay-default` endpoint on-chain + funds its pool.
