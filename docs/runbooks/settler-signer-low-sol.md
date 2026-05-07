# Runbook: settler signer low SOL

**Severity:** P2 (WARN) → P1 (CRIT)
**Service:** `pact-settler` (Cloud Run, project `pact-network`, region `asia-southeast1`)
**Signer pubkey:** `FuT7kRVwHbGgLNMULyhxU57VvDVtPMk7UqZT5DDK2ST1`
**Owner:** on-call SRE, escalation rick@quantum3labs.com
**Last rev:** 2026-05-07 (post first-mainnet-settle postmortem)

## TL;DR

The settler's SettlementAuthority signer pays the SOL fee on every
`settle_batch` mainnet tx (~10,000 lamports each). If it runs out, every
batch simulation fails with `Attempt to debit an account but found no record
of a prior credit` and Pub/Sub will redeliver until messages hit the DLQ.
Top up from the funding wallet listed below.

## When this fires

One of the following is true:

1. The Cloud Monitoring alert `settler-signer-sol-low` is firing
   (gauge `prometheus.googleapis.com/settler_signer_sol_lamports/gauge` <
   10_000_000 = 0.01 SOL for >5 min) — WARN.
2. The Cloud Monitoring alert `settler-signer-sol-critical` is firing
   (same gauge < 3_000_000 = 0.003 SOL) — CRIT, paging.
3. `https://settler.internal/health` (or whatever the Cloud Run revision
   URL is — settler is `INGRESS_TRAFFIC_INTERNAL_ONLY`) returns HTTP 503
   with `status: "unhealthy"` and the reason mentions the CRIT floor.
4. Settler logs spam:
   `submit attempt N/3 failed: SendTransactionError: ...
    Attempt to debit an account but found no record of a prior credit`
5. Pub/Sub topic `pact-settle-events-dlq` starts accumulating messages
   (last-resort sign — by the time this happens we're already firing).

## Verify

### 1. Check signer balance directly via RPC

```bash
SIGNER=FuT7kRVwHbGgLNMULyhxU57VvDVtPMk7UqZT5DDK2ST1

curl -s https://api.mainnet-beta.solana.com \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"getBalance",
    "params":["'"$SIGNER"'"]
  }' | jq .
```

Returned `result.value` is in lamports. Sanity table:

| Lamports     | SOL    | ~Settles remaining |
|--------------|--------|--------------------|
| 50_000_000   | 0.050  | ~5,000             |
| 10_000_000   | 0.010  | ~1,000  (WARN)     |
|  3_000_000   | 0.003  | ~300    (CRIT)     |
|          0   | 0.000  | 0       (broken)   |

You can also use `solana balance` if you have the CLI:

```bash
solana balance "$SIGNER" --url https://api.mainnet-beta.solana.com
```

### 2. Confirm via the settler's own /health

`settler.internal` is internal-only; from a Cloud Shell in the
`pact-network` project:

```bash
gcloud run services proxy pact-settler --region=asia-southeast1 --port=8080
# in another terminal
curl -s http://localhost:8080/health | jq .
```

Expected fields: `signer.lamports`, `signer.sol`, `signer.last_polled_at`,
`signer.threshold_warn_lamports`, `signer.threshold_crit_lamports`.

### 3. Look at the gauge in Cloud Monitoring

Metric Explorer:

- **Resource type:** `prometheus_target`
- **Metric:** `prometheus.googleapis.com/settler_signer_sol_lamports/gauge`

The full filter the alert policies use (see
`devops/terraform-gcp/pact-network/alerts.tf`):

```
metric.type="prometheus.googleapis.com/settler_signer_sol_lamports/gauge"
AND resource.type="prometheus_target"
```

Note: there is **no `service_name` filter** — the metric name itself is
unique to the settler. `prometheus_target` resource labels are
`project_id`, `location`, `cluster`, `namespace`, `job`, `instance`; if
you need to scope further (e.g. multiple settler revisions), filter by
`resource.label.job` or `resource.label.cluster`, not `service_name`.

A gauge value of `-1` means the settler hasn't successfully fetched the
balance yet (RPC failure at boot). That's its own incident — see
"Failure modes" below.

## Fix

### Top up the signer

**Funding wallet (used 2026-05-07 for first mainnet top-up):**
`82M4Z7CceE9b722CLuQQiC7XH4QMq5CPXyqkm8rWPa9X`

Recommended top-up amounts:

| Trigger                  | Top-up to     | Why                                     |
|--------------------------|---------------|-----------------------------------------|
| WARN (< 0.01 SOL)        | 0.05 SOL      | Restores ~5,000 settles of headroom.    |
| CRIT (< 0.003 SOL)       | 0.10 SOL      | Larger buffer because we're already in  |
|                          |               | the danger zone — buys time to investigate |
|                          |               | whether usage spiked or this is a leak.  |
| Hot-key rotation         | match prior   | Don't change the float just because you  |
|                          |               | rotated keys.                            |

**Hard cap: never hold more than ~1 SOL on the signer.** It's a hot key on
a Cloud Run service; the Secret Manager secret
`PACT_SETTLEMENT_AUTHORITY_BS58` is accessible to anyone with
`secretAccessor` on `pact-network`. The blast radius is the float on the
signer, so we keep the float small.

### Top-up procedure

**Preferred path: use the topup script in this repo.**

```bash
cd packages/scripts/mainnet     # or wherever the runner lives
pnpm install
# Dry run — prints recipient, current balance, source wallet, amount, tx skeleton:
pnpm tsx topup-settler.ts --amount 0.05
# Actually send:
pnpm tsx topup-settler.ts --amount 0.05 --confirm
```

Required env:
- `SOLANA_RPC_URL` — mainnet RPC (Helius / Alchemy URL with API key, NOT
  public mainnet-beta which 429s).
- `FUNDING_WALLET_KEY` — base58-encoded secret key for the source wallet.
  **Never** use the SettlementAuthority key as the source.

The script:
1. Validates the recipient pubkey matches the on-chain SettlementAuthority
   `signer` field on the `SettlementAuthority` PDA. If a key rotation has
   moved the signer, this catches stale runbooks before they send SOL to
   the wrong account.
2. Prints the amount, source pubkey, current source balance, current
   recipient balance, and asks for `--confirm`.
3. Sends a single `SystemProgram.transfer` ix, confirms, prints the tx
   signature.

**Manual fallback (no script available):**

```bash
SIGNER=FuT7kRVwHbGgLNMULyhxU57VvDVtPMk7UqZT5DDK2ST1
solana transfer --keypair ~/.config/solana/funding-wallet.json \
                --from ~/.config/solana/funding-wallet.json \
                --url https://api.mainnet-beta.solana.com \
                "$SIGNER" 0.05 --allow-unfunded-recipient
```

### After top-up

1. Re-check `getBalance` to confirm the credit landed.
2. Hit `/health` and confirm `status` is `ok`.
3. If the alert was CRIT and Pub/Sub messages had failed: settler retries
   on a 5-min loop (consumer redelivery + idempotency-on-retry path).
   No manual nack/replay is needed unless the DLQ has accumulated — see
   `docs/runbooks/dlq-replay.md` (TODO).
4. Annotate the incident with the tx signature and the source wallet
   balance pre/post.

## Why we don't keep more than ~1 SOL on a hot key

The signer secret lives in Secret Manager as
`PACT_SETTLEMENT_AUTHORITY_BS58` and is mounted into a Cloud Run service.
The blast radius if it's compromised is bounded by the SOL on the signer
**plus** any SPL Token allowances the signer has been granted (currently:
the SettlementAuthority PDA is the SPL Token delegate on agent ATAs —
agent custody risk is governed by per-agent allowance, not by signer
SOL).

Even so, treat the signer as if it can be drained at any moment:

- Float = ~0.05 SOL for steady-state. ~0.10 SOL while we're observing
  burn rate. **Never** > 1 SOL.
- Top-up frequency: prefer 5× small top-ups per week over 1× large.
- If the alert is firing weekly: that's a usage signal, not a top-up
  problem. Investigate `settler_batch_size` + call rate metrics first.

## Long term — kill this runbook

This runbook is a band-aid. The right fix is a multisig-controlled
auto-topup:

1. Funding source = a Squads multisig (2-of-3 minimum) holding ~10 SOL.
2. A scheduled Cloud Function or Cloud Run Job runs every hour: reads
   `getBalance(signer)`, and if `< 0.02 SOL` builds a transfer proposal
   in the multisig.
3. One signer auto-approves on a hard upper-bound (e.g. only proposals
   ≤ 0.05 SOL); the other requires a human.
4. Result: signer is auto-topped to a known-bounded float, no human in
   the loop for normal operation, multisig withdrawals require human
   approval.

Tracked in: `mainnet-launch-checklist.md` → "Authority rotation" section.
Owner: SRE. Target: post first-month operational data.

## Failure modes (read before paging the developer)

| Symptom                                  | Likely cause                                    | Action                                        |
|------------------------------------------|-------------------------------------------------|-----------------------------------------------|
| `signer.lamports = -1` in /health         | Settler can't reach mainnet RPC                 | Check `SOLANA_RPC_URL` env on settler revision; check Helius/Alchemy quota. |
| Balance unchanged for hours, alert firing | Settler crashed mid-poll; cron not running     | `gcloud run services describe pact-settler` — check logs for startup errors. |
| Balance is fine but `settle_batch` fails  | Different bug — protocol paused, USDC mint mismatch, etc. | DO NOT top up. See `submitter.service.ts` for breaks; check for `ProtocolPaused (6032)` errors. |
| Pub/Sub DLQ accumulating                  | Look at the actual error in the failed message | DLQ replay is its own runbook — don't reflexively top up. |
| `signer` pubkey in /health is unfamiliar  | Key rotation happened and runbook is stale     | STOP. Verify against on-chain SettlementAuthority PDA before sending SOL anywhere. |

## Constants

| Field                               | Value                                              |
|-------------------------------------|----------------------------------------------------|
| Signer pubkey                       | `FuT7kRVwHbGgLNMULyhxU57VvDVtPMk7UqZT5DDK2ST1`     |
| Secret Manager secret name          | `PACT_SETTLEMENT_AUTHORITY_BS58`                   |
| Funding wallet (used 2026-05-07)    | `82M4Z7CceE9b722CLuQQiC7XH4QMq5CPXyqkm8rWPa9X`     |
| Project                             | `pact-network` (number `224627201825`)             |
| Region                              | `asia-southeast1`                                  |
| Service                             | Cloud Run `pact-settler`                           |
| Metric                              | `prometheus.googleapis.com/settler_signer_sol_lamports/gauge` (resource type `prometheus_target`) |
| WARN threshold                      | `10_000_000` lamports (0.01 SOL)                   |
| CRIT threshold                      | `3_000_000` lamports (0.003 SOL)                   |
| /health                             | HTTP 200 ok / 200 degraded / 503 unhealthy         |
| Alert routing                       | Pub/Sub topic `pact-alerts` + email rick@…         |

## Related

- Postmortem: `~/.claude/.../memory/mainnet_first_settle_2026_05_07.md`
- Off-chain stack notes: `~/.claude/.../memory/mainnet_offchain_stack.md`
- Source: `packages/settler/src/health/signer-balance.service.ts`
- Tests: `packages/settler/src/health/signer-balance.service.spec.ts`
