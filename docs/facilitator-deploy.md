# pact-facilitator — Cloud Run deploy runbook (facilitator.pact.network)

Step-by-step deploy for the **pact-facilitator** service: `facilitator.pact.network`,
the pay.sh / x402 **premium-coverage register** service. See `docs/premium-coverage-mvp.md`
Part B for the design and `packages/facilitator/README.md` for the API contract.

Unlike `pact-dummy-upstream`, this service **has env vars** (no secrets needed for the
MVP — it doesn't sign on-chain txs; it only reads RPC + Postgres and publishes to
Pub/Sub, which Cloud Run's default service account already has access to). It does **not**
hold any keypair: the on-chain `settle_batch` is driven by the existing `pact-settler`
off the shared Pub/Sub topic.

| Thing | Value |
|---|---|
| Service name | `pact-facilitator` |
| Public hostname | `https://facilitator.pact.network` |
| GCP project | `pact-network` (project number `224627201825`) |
| Region | `asia-southeast1` |
| Artifact Registry repo | `pact-network` |
| Image | `asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-facilitator:latest` |
| Dockerfile | `packages/facilitator/Dockerfile` |
| Listen port | `$PORT` (Cloud Run injects `8080`) |
| Scale | `min=0`, `max=2` (single-replica replay cache — see note in `verify-signature.ts`) |
| Ingress | `all` |
| Auth | unauthenticated (`allUsers` → `roles/run.invoker`) — the `POST /v1/coverage/register` route is itself ed25519-authenticated. |
| Env vars | `PG_URL`, `RPC_URL`, `PROGRAM_ID`, `USDC_MINT`, `PUBSUB_PROJECT`, `PUBSUB_TOPIC` (+ optional `PAY_DEFAULT_*` overrides) — see `packages/facilitator/README.md`. **`PUBSUB_TOPIC` MUST be the same topic the `pact-market-proxy` publishes to** (the `pact-settler` subscribes to it). |
| Secrets | none. |
| Terraform | (to be added under `devops/terraform-gcp/pact-network/` — mirror `pact-dummy-upstream`'s module + a domain mapping. Until then use the `gcloud` escape hatches below.) |

> This follows the same build → deploy pattern as the other pact-network Cloud Run
> services (`build-pact-network.yaml` → `deploy-pact-network.yaml`). The extra steps
> vs. an LB-fronted service: the **domain mapping** + the **CNAME** (Cloud Run
> custom-domain, like `dummy.pactnetwork.io`), and the **`pay-default` coverage-pool
> bootstrap** (§6) so the facilitator can actually pay refunds.

---

## 0. Dependencies / pre-flight

- [ ] **`packages/facilitator/` is on `develop` (and merged to whatever branch the
      build workflow runs from — usually `main` after `develop`→`main`).** Confirm:
      ```bash
      gh api repos/pactnetwork/pact-monitor/contents/packages/facilitator/Dockerfile --jq .path
      ```
      If that 404s on the build ref, **stop and wait**.
- [ ] **`pact-facilitator` is a valid `service_name` choice in both workflows.** This
      PR adds it to `build-pact-network.yaml` (`inputs.service_name.options` **and**
      the dockerfile-path `case`) and `deploy-pact-network.yaml` (`inputs.service_name.options`).
      Check on the build ref:
      ```bash
      gh api repos/pactnetwork/pact-monitor/contents/.github/workflows/build-pact-network.yaml --jq '.content' | base64 -d | grep -n pact-facilitator
      ```
      If missing, `gh workflow run … -f service_name=pact-facilitator` will fail input validation.
- [ ] **The shared settlement Pub/Sub topic + subscription exist** (the `pact-market-proxy`
      / `pact-settler` already use them). You'll point `PUBSUB_TOPIC` at that same topic
      — the settler's subscription will then deliver pay.sh events alongside gateway events.
      Find the topic name the proxy uses:
      ```bash
      gcloud run services describe pact-market-proxy --region asia-southeast1 --project pact-network \
        --format='value(spec.template.spec.containers[0].env)' | tr ',' '\n' | grep -i pubsub
      ```
- [ ] **The shared Postgres** (the indexer's DB) is reachable from Cloud Run (same
      `PG_URL` the `pact-indexer` uses — via the same VPC connector / Cloud SQL proxy
      sidecar, whatever the others use).
- [ ] **The protocol is initialised on the target cluster** (ProtocolConfig + Treasury +
      SettlementAuthority) — required for the `pay-default` bootstrap in §6. On mainnet
      this is already done (see `docs/mainnet-program-deploy.md` / `mainnet-launch-checklist.md`).
- [ ] You can run `gh` against `pactnetwork/pact-monitor` (already authed), have `gcloud`
      configured for project `pact-network` with rights to create domain mappings + update
      Cloud Run env, and you know who manages `pactnetwork.io` DNS.
- [ ] You hold the **protocol-authority keypair** (`PACT_PRIVATE_KEY`) for §6, and its
      USDC ATA on the target cluster holds ≥ the bootstrap seed (default 25.00 USDC).

---

## 1. Build the image

```bash
gh workflow run build-pact-network.yaml \
  --repo pactnetwork/pact-monitor \
  --ref main \
  -f environment=production \
  -f service_name=pact-facilitator
```

Wait for green:

```bash
RUN_ID=$(gh run list --repo pactnetwork/pact-monitor \
  --workflow build-pact-network.yaml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --repo pactnetwork/pact-monitor --exit-status
```

On success the image is at
`asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-facilitator:<short-sha>`
and `:latest`.

---

## 2. Deploy to Cloud Run (image only)

```bash
gh workflow run deploy-pact-network.yaml \
  --repo pactnetwork/pact-monitor \
  --ref main \
  -f environment=production \
  -f service_name=pact-facilitator
```

This does a bare `gcloud run deploy pact-facilitator --image …:latest --region
asia-southeast1 --platform managed`. It does NOT set env vars (the deploy workflow
deliberately preserves existing env across deploys; the `INDEXER_PUSH_SECRET`
re-assertion step only fires for indexer/settler). So on a **first deploy** the
service comes up with **no env** and will crash-loop on `env.ts`'s zod validation
— that's expected; set the env in §3.

> If Terraform hasn't been applied yet the service may not exist when the deploy
> workflow runs. Either apply Terraform first, or let this first `gcloud run deploy`
> create the service. Make sure the public-invoker IAM ends up set:
> ```bash
> gcloud run services add-iam-policy-binding pact-facilitator \
>   --region asia-southeast1 --project pact-network \
>   --member=allUsers --role=roles/run.invoker
> ```

---

## 3. Set the env vars

(Once — these persist across `deploy` runs, mirroring how the other services'
env/secrets are managed out of band. Re-run only when a value changes.)

```bash
# Reuse the SAME Pub/Sub topic the market-proxy publishes to (see §0).
PUBSUB_TOPIC=<the proxy's PUBSUB_TOPIC, e.g. pact-settlement-events>

gcloud run services update pact-facilitator \
  --region asia-southeast1 --project pact-network \
  --update-env-vars \
PG_URL="<same PG_URL as pact-indexer>",\
RPC_URL="https://mainnet.helius-rpc.com/?api-key=<key>",\
PROGRAM_ID="<mainnet V1 program id>",\
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",\
PUBSUB_PROJECT="pact-network",\
PUBSUB_TOPIC="$PUBSUB_TOPIC"
# optional overrides (defaults are sane — see packages/facilitator/README.md):
#   PAY_DEFAULT_SLUG=pay-default
#   PAY_DEFAULT_FLAT_PREMIUM_LAMPORTS=1000
#   PAY_DEFAULT_IMPUTED_COST_LAMPORTS=1000000
#   PAY_DEFAULT_SLA_LATENCY_MS=10000
#   PAY_DEFAULT_EXPOSURE_CAP_PER_HOUR_LAMPORTS=5000000
```

> The Cloud Run default service account needs `roles/pubsub.publisher` on the
> topic. If publishing 403s in the logs (`[facilitator] Pub/Sub publish failed`),
> grant it:
> ```bash
> gcloud pubsub topics add-iam-policy-binding "$PUBSUB_TOPIC" --project pact-network \
>   --member="serviceAccount:$(gcloud run services describe pact-facilitator --region asia-southeast1 --project pact-network --format='value(spec.template.spec.serviceAccountName)')" \
>   --role=roles/pubsub.publisher
> ```

Sanity-check the auto-assigned URL:

```bash
SVC_URL=$(gcloud run services describe pact-facilitator \
  --region asia-southeast1 --project pact-network --format='value(status.url)')
curl -s "$SVC_URL/health"
# expect: {"status":"ok","service":"pact-facilitator",...}
curl -s "$SVC_URL/.well-known/pay-coverage" | jq
# expect: model "side-call", supportedSchemes ["x402","mpp"], a pay-default pool
#   (configSource "env-fallback" until §6 + the DB seed land, then "db")
```

---

## 4. Create the domain mapping + add the CNAME

### 4a. Create the mapping
```bash
gcloud beta run domain-mappings create \
  --service pact-facilitator \
  --domain facilitator.pact.network \
  --region asia-southeast1 \
  --project pact-network
```

### 4b. Read back the DNS records it wants
```bash
gcloud beta run domain-mappings describe \
  --domain facilitator.pact.network \
  --region asia-southeast1 --project pact-network \
  --format='value(status.resourceRecords)'
```
For a subdomain, Cloud Run wants a single CNAME:

| Name | Type | Value |
|---|---|---|
| `facilitator.pact.network` | `CNAME` | `ghs.googlehosted.com.` |

### 4c. Add the CNAME at the `pact.network` DNS provider
```
facilitator   CNAME   ghs.googlehosted.com.
```
(This repo does not manage the `pact.network` zone — add it wherever that zone lives.
NB: the gateway uses `*.pactnetwork.io`; the facilitator design names it
`facilitator.pact.network`. If `pact.network` isn't a managed zone, use
`facilitator.pactnetwork.io` instead and adjust the design doc + CLI default — flag
this to whoever owns DNS.)

### 4d. Wait for the cert
```bash
gcloud beta run domain-mappings describe \
  --domain facilitator.pact.network --region asia-southeast1 --project pact-network \
  --format='value(status.conditions)'
```
`CertificateProvisioning` → `Ready` is usually 15–30 min after the CNAME resolves.

---

## 5. Apply Terraform (service of record) — when the module exists

Mirror `pact-dummy-upstream`'s pattern: a `module.pact_facilitator` (Cloud Run
service + public-invoker IAM) + a `google_cloud_run_domain_mapping.facilitator`
under `devops/terraform-gcp/pact-network/`. Note: env vars on the facilitator
should be managed the same way the other services' are — either via the module's
`env` block **or** via the `--update-env-vars` escape hatch in §3, with
`lifecycle.ignore_changes = [template[0].containers[0].env]` so deploys don't
clobber them. Until the module exists, §2–§4 via `gcloud` is the path.

---

## 6. Bootstrap the `pay-default` coverage pool (so refunds can actually pay out)

The facilitator publishes settlement events with `endpointSlug: "pay-default"`.
That on-chain `EndpointConfig` + its `CoveragePool` must exist and be funded, or
the settler's `settle_batch` will fail to resolve the pool. Two things, in any order:

### 6a. On-chain: register the endpoint + fund the pool
```bash
# dry run first (prints derived PDAs + planned txs, sends nothing):
PACT_PRIVATE_KEY=<protocol-authority keypair> \
PACT_RPC_URL="https://mainnet.helius-rpc.com/?api-key=<key>" \
PROGRAM_ID=<mainnet V1 program id> \
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  pnpm --filter @pact-network/facilitator exec tsx ../../scripts/pay-default-bootstrap.ts --mainnet

# for real (mainnet — note BOTH --mainnet and --confirm):
PACT_PRIVATE_KEY=... PACT_RPC_URL=... PROGRAM_ID=... USDC_MINT=... \
  pnpm --filter @pact-network/facilitator exec tsx ../../scripts/pay-default-bootstrap.ts --mainnet --confirm
```
(For devnet/staging: same but `USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`,
the devnet program id, and **omit `--mainnet`**.) The authority's USDC ATA must
already exist and hold ≥ the seed amount (default 25.00 USDC; override via
`SEED_USDC_LAMPORTS`). See `scripts/pay-default-bootstrap.ts` for the full contract.

Verify:
```bash
solana account <CoveragePool PDA printed by the script> --url $PACT_RPC_URL   # endpoint_slug "pay-default", current_balance > 0
solana account <EndpointConfig PDA printed by the script> --url $PACT_RPC_URL  # paused=0, flat_premium_lamports=1000
```

### 6b. Postgres: seed the matching `Endpoint` row + reload the market-proxy registry
```bash
PG_URL="<same PG_URL>" pnpm --filter @pact-network/db exec tsx seeds/pay-default-endpoint.ts
# (the indexer's OnChainSyncService overwrites the on-chain-derived columns within 5 min;
#  this seed sets upstreamBase/displayName so a chain-first create still resolves.)

curl -X POST https://<market-proxy-host>/admin/reload-endpoints \
  -H "Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN"
```
(The schema migration `20260511000000_call_payee_resource` — adding `Call.payee` /
`Call.resource` — must already be applied to that Postgres; it ships in this PR
under `packages/db/prisma/migrations/`. Apply it via the indexer's normal
`prisma migrate deploy` step / however migrations are run in this repo.)

After this, `curl -s https://facilitator.pact.network/.well-known/pay-coverage | jq`
should show the `pay-default` pool with `configSource: "db"` and the seeded values.

---

## 7. Verify end-to-end

```bash
# 1. liveness + metadata
curl -s https://facilitator.pact.network/health
curl -s https://facilitator.pact.network/.well-known/pay-coverage | jq

# 2. an unsigned register call is rejected (auth required)
curl -si -X POST https://facilitator.pact.network/v1/coverage/register \
  -H 'content-type: application/json' -d '{}'
# expect: HTTP/2 401  {"error":"pact_auth_missing",...}

# 3. a real end-to-end flow (devnet/staging recommended first): run a `pact pay`
#    against an x402 merchant once the CLI side (cli-facilitator-wiring PR) is
#    live, then `GET /v1/coverage/<coverageId>` — it returns settlement_pending
#    immediately, then `settled` with the settle_batch tx signature once the
#    settler processes the Pub/Sub event. Open https://solscan.io/tx/<sig>.
```

If `curl` against the bare `*.run.app` URL works but the custom domain doesn't:
404 from Google → CNAME not propagated / mapping not created; TLS error → cert
still provisioning; 403 → public-invoker IAM missing (see §2 fix); 500 on `/health`
→ env not set or Postgres unreachable (`/health` doesn't touch the DB, so a 500
there means the container crashed on `env.ts` validation — check `gcloud run
services logs read pact-facilitator`).

---

## 8. Rollback / teardown

```bash
# 1. domain mapping (frees the hostname; do this first)
gcloud beta run domain-mappings delete --domain facilitator.pact.network \
  --region asia-southeast1 --project pact-network --quiet
# 2. the Cloud Run service
gcloud run services delete pact-facilitator --region asia-southeast1 --project pact-network --quiet
# 3. remove the CNAME `facilitator → ghs.googlehosted.com` at the DNS provider.
# 4. (optional) delete images
gcloud artifacts docker images delete \
  asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-facilitator \
  --project pact-network --delete-tags --quiet
```
The `pay-default` on-chain endpoint/pool can stay (it does no harm idle). To roll
back a bad revision without teardown: `gcloud run revisions list --service
pact-facilitator …` then `gcloud run services update-traffic pact-facilitator
--to-revisions=…=100 …`.

---

## Summary of what needs doing outside this PR

| Item | Owner | Status |
|---|---|---|
| CLI side: `pact pay` → `POST /v1/coverage/register` (`packages/cli`) | `cli-facilitator-wiring` agent (parallel PR) | dependency for the end-to-end flow; the backend works without it. |
| Terraform `module.pact_facilitator` + domain mapping under `devops/terraform-gcp/pact-network/` | devops repo PR | pending — use the §2–§4 `gcloud` escape hatches until then |
| Add CNAME `facilitator.pact.network → ghs.googlehosted.com.` (or decide `facilitator.pactnetwork.io` — see §4c) | whoever manages the DNS zone | manual, after `domain-mappings create` |
| Run the schema migration `20260511000000_call_payee_resource` on the shared Postgres | operator (indexer migrate step) | ships in this PR; apply on deploy |
| Build → deploy → set env → domain mapping → bootstrap `pay-default` → verify | operator | this runbook |
