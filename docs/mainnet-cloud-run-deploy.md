# Pact Network V1 — Mainnet Cloud Run Deploy Plan

Operational runbook for the V1 off-chain stack on GCP Cloud Run for mainnet.

**Audience:** the operator running the deploy (Rick + Claude).

---

## 0. How this is deployed

This deployment follows the **standard Quantum3-Labs DevOps pattern**. There are
no hand-rolled GCP commands or invented infra in this repo — everything that
provisions cloud resources is in the `devops` repo, and CI/CD uses the standard
monorepo workflow templates.

| Layer | Where it lives |
|---|---|
| **Infrastructure (Terraform)** | `~/devops/terraform-gcp/pact-network-prod/` |
| **CI/CD workflows** | `pact-monitor/.github/workflows/build-pact-network.yaml` + `deploy-pact-network.yaml` |
| **Pattern reference** | `~/devops/DEVOPS_HANDBOOK.md`, `~/devops/terraform.md` |
| **Pipeline pattern** | `~/devops/pipelines-gcp/howto.md`, `~/devops/pipelines-gcp/qash/` (monorepo template this repo's workflows were copied from) |

To bring up production:

1. Rick creates the `pact-network-prod` GCP project + links billing.
2. Capture `project_number`; fill it into `terraform-gcp/pact-network-prod/terraform.tfvars` and the two GitHub workflows.
3. `cd ~/devops/terraform-gcp/pact-network-prod && terraform init && terraform apply`.
4. Add GitHub repo secrets (`ENV_PROD`, `ORG_GITHUB_TOKEN`). Push two RPC API keys via `gcloud secrets versions add`: `PACT_ALCHEMY_API_KEY` (Pact's internal Solana RPC) and `PACT_HELIUS_API_KEY` (upstream for the user-facing `helius` endpoint slug).
5. Trigger `build-pact-network.yaml` (per service) → `deploy-pact-network.yaml` (per service).
6. Phase 2: point `api.pactnetwork.io` and `indexer.pactnetwork.io` A records at the LB IP from `terraform output lb_ip`. Wait 15-30 min for SSL.

The operational sections below describe what runs where, env vars, monitoring, cost, and rollback. **Do NOT run gcloud commands by hand to create infra — use Terraform.**

---

## 1. Architecture overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                         agents (off-VPC)                              │
│                                                                       │
│   wrap library (in agent's process) → x402 calls + classification     │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  HTTPS
┌────────────────────────────────────────────────────────────────────────┐
│  Cloud Run: pact-market-proxy   Public — api.pactnetwork.io           │
│  - Hono on Node 22, asia-southeast1                                    │
│  - Wraps Helius / Birdeye / Jupiter / Elfa / fal.ai upstreams         │
│  - Classifies, charges premium via SPL Token CPI                       │
│  - Publishes settle events to Pub/Sub                                  │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  Pub/Sub publish
                ┌─────────────────────────────────┐
                │  Pub/Sub topic: pact-settle-events│
                │  + subscription: pact-settle-events-settler │
                │  + DLQ: pact-settle-events-dlq    │
                └─────────────────────────────────┘
                              │
                              ▼  Pub/Sub pull
┌────────────────────────────────────────────────────────────────────────┐
│  Cloud Run: pact-settler        Internal-only ingress (no public LB)  │
│  - NestJS on Node 22                                                    │
│  - Batches up to 3 events / 5s                                         │
│  - Submits settle_batch txs to mainnet Solana RPC                      │
│  - Pushes settled batches to indexer over HTTPS                        │
│  - Reads settlement-authority keypair from Secret Manager              │
└────────────────────────────────────────────────────────────────────────┘
            │                                                │
            │  RPC                                           │ HTTPS
            ▼                                                ▼
   ┌──────────────────┐                  ┌────────────────────────────────┐
   │ Solana mainnet   │                  │ Cloud Run: pact-indexer        │
   │ - Alchemy        │                  │ - NestJS, asia-southeast1      │
   │ - api.mainnet... │                  │ - Public read API at           │
   │   (HA fallback)  │                  │   indexer.pactnetwork.io       │
   │                  │                  │ - Connects to Cloud SQL        │
   └──────────────────┘                  └────────────────────────────────┘
                                                          │
                                                          ▼
                                           ┌────────────────────────────────┐
                                           │ Cloud SQL: pact-network-prod-db│
                                           │ - Postgres 17, db-custom-1-3840│
                                           │ - Private IP only              │
                                           └────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│  Vercel: market-dashboard          Public — app.pactnetwork.io        │
│  - Next.js 15                                                          │
│  - Reads from indexer.pactnetwork.io                                   │
│  - Wallet connect via @solana/wallet-adapter                           │
└────────────────────────────────────────────────────────────────────────┘
```

Five deployables:
- **pact-market-proxy** → Cloud Run (public, behind LB)
- **pact-settler** → Cloud Run (internal-only ingress; no public LB)
- **pact-indexer** → Cloud Run (public read API, behind LB)
- **market-dashboard** → Vercel (public)
- **postgres** → Cloud SQL (private)

Plus three GCP-managed resources (all created by Terraform): Pub/Sub topic + subscription + DLQ, Secret Manager (for settlement-authority keypair, indexer push secret, db password, Alchemy API key, Helius API key), and Cloud SQL.

---

## 2. Vercel setup (market-dashboard)

> Cloud Run services come from Terraform — see §0. This section is the only piece of infra that lives outside the standard pattern, because Vercel handles SSR/ISR/edge correctly for Next.js 15.

```bash
cd packages/market-dashboard
vercel link  # creates .vercel/project.json (gitignored)

vercel env add NEXT_PUBLIC_USDC_MINT production
# value: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

vercel env add NEXT_PUBLIC_INDEXER_URL production
# value: https://indexer.pactnetwork.io

vercel env add NEXT_PUBLIC_RPC_URL production
# value: https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}

vercel env add NEXT_PUBLIC_PROGRAM_ID production
# value: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc

vercel --prod
```

Domain: `app.pactnetwork.io` (CNAME to Vercel).

---

## 3. Env-var matrix

Build-time env (baked into the Docker image from a `.env` file) lives in the GitHub repo secret `ENV_PROD`. Runtime secrets (signed bytes, API keys with rotation) live in GCP Secret Manager and are bound via `--set-secrets` on first deploy. See `~/devops/terraform.md` §"Env & Secrets" for the canonical pattern.

### Common (all 3 services, in `ENV_PROD`)

```yaml
NODE_ENV: production
PROGRAM_ID: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
USDC_MINT: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
GOOGLE_CLOUD_PROJECT: pact-network-prod
LOG_LEVEL: info
```

### pact-market-proxy

```yaml
PUBSUB_TOPIC: projects/pact-network-prod/topics/pact-settle-events
# Upstream URL for the `helius` endpoint slug we proxy on behalf of users.
# Separate concern from Pact's own internal Solana RPC (SOLANA_RPC_URL below).
HELIUS_UPSTREAM_URL: https://mainnet.helius-rpc.com/?api-key=${PACT_HELIUS_API_KEY}
# Internal Solana RPC for chain reads (SPL Token Approval state, agent ATA balances, etc.)
SOLANA_RPC_URL: https://solana-mainnet.g.alchemy.com/v2/${PACT_ALCHEMY_API_KEY}
BIRDEYE_UPSTREAM_URL: https://public-api.birdeye.so
JUPITER_UPSTREAM_URL: https://api.jup.ag
ELFA_UPSTREAM_URL: https://api.elfa.ai
FAL_UPSTREAM_URL: https://queue.fal.run
DEMO_BREACH_ALLOWLIST: ""  # MUST be empty in prod
```

Secrets bound to env (`--set-secrets`):
- `PACT_HELIUS_API_KEY` — for forwarding user calls to the `helius` endpoint slug
- `PACT_ALCHEMY_API_KEY` — for Pact's internal Solana RPC reads

### pact-settler

```yaml
RPC_URL: https://solana-mainnet.g.alchemy.com/v2/${PACT_ALCHEMY_API_KEY}
PUBSUB_PROJECT: pact-network-prod
PUBSUB_SUBSCRIPTION: pact-settle-events-settler
INDEXER_URL: https://indexer.pactnetwork.io
PORT: 8080
SETTLER_BATCH_SIZE: 3   # MAX_BATCH_SIZE per FIX-1
```

Secrets bound to env (`--set-secrets`):
- `PACT_SETTLEMENT_AUTHORITY_JSON` → mounted, NOT env-injected. Set `SETTLEMENT_AUTHORITY_KEYPAIR_PATH` to the mount path.
- `PACT_INDEXER_PUSH_SECRET`
- `PACT_ALCHEMY_API_KEY` — for `settle_batch` tx submission + chain state reads

### pact-indexer

```yaml
PORT: 8080
DATABASE_URL: postgresql://pact:${PACT_DB_PASSWORD}@/pact?host=/cloudsql/${CLOUDSQL_CONNECTION_NAME}
```

Secrets bound to env (`--set-secrets`):
- `PACT_DB_PASSWORD`
- `PACT_INDEXER_PUSH_SECRET`

Migration: `prisma migrate deploy` runs on cold start in the indexer image (idempotent). Add a Cloud Run Job invocation to the deploy workflow if we want to gate revisions on a successful migration before they go live.

---

## 4. DNS

Three records needed at `pactnetwork.io`:

| Subdomain | Type | Target |
|---|---|---|
| `api.pactnetwork.io` | A | LB IP from `terraform output lb_ip` |
| `indexer.pactnetwork.io` | A | LB IP from `terraform output lb_ip` (same IP, served via host rule) |
| `app.pactnetwork.io` | CNAME | Vercel |

After A records propagate, Google-managed SSL certs go ACTIVE in 15-30 min. **The TF apply creates the certs but they sit in PROVISIONING state until DNS resolves.**

---

## 5. Monitoring + alerts

### Cloud Monitoring uptime checks

```bash
gcloud monitoring uptime create-http \
  --display-name="pact-market-proxy /health" \
  --resource-type=uptime-url \
  --resource-labels=host=api.pactnetwork.io \
  --request-path=/health

gcloud monitoring uptime create-http \
  --display-name="pact-indexer /health" \
  --resource-type=uptime-url \
  --resource-labels=host=indexer.pactnetwork.io \
  --request-path=/health
```

### Alert policies (wire to Slack + phone)

| Metric | Threshold | Severity |
|---|---|---|
| pact-settler error rate (`run.googleapis.com/request_count` filtered to 5xx) | > 5/min for 5min | high |
| pact-settler queue depth (`pact-settle-events-settler` `num_undelivered_messages`) | > 100 for 10min | high |
| pact-settler RPC failure rate (custom log metric on "rpc down" warns) | > 0.1/sec for 5min | medium |
| Cloud SQL CPU | > 90% for 10min | medium |
| pact-indexer error rate | > 5/min for 5min | medium |
| Cloud Run instance crash loop (revision rollback) | any | high |
| DLQ depth (`pact-settle-events-dlq` `num_undelivered_messages`) | > 0 | high (anything in DLQ = escalate) |

The settler emits prom-style metrics on `:8080/metrics`; scrape via Managed Prometheus.

### Logs

Default Cloud Logging captures stdout/stderr. Useful filters:

```
# Settler errors
resource.type="cloud_run_revision"
resource.labels.service_name="pact-settler"
severity>=ERROR

# Indexer 500s
resource.type="cloud_run_revision"
resource.labels.service_name="pact-indexer"
httpRequest.status>=500
```

Pin these as saved Logs Explorer queries.

---

## 6. Cost estimate (per month, beta scale)

> The canonical projection now lives in `~/devops/budget.md` §5b. The numbers below are the operational view (USD, with mainnet-specific add-ons that aren't in the GCP budget).

| Resource | Tier | Cost USD/mo |
|---|---|---|
| pact-market-proxy Cloud Run | min=0, scale to load | $5-20 |
| pact-settler Cloud Run | min=1, 24/7 | $25-40 |
| pact-indexer Cloud Run | min=1, 24/7 | $25-40 |
| Cloud SQL `db-custom-1-3840` | + 10GB SSD | $50-60 |
| Pub/Sub | 1M msg/mo at beta | <$1 |
| Secret Manager | 4-5 secrets | <$1 |
| Artifact Registry | 1 repo (3 service images) | <$1 |
| Cloud Run egress | low at beta | $1-5 |
| Vercel hobby (dashboard) | hobby tier | $0-20 |
| **Subtotal (GCP + Vercel)** | | **~$110-185/mo** |
| Alchemy Solana RPC (Pact's internal RPC) | growth tier if exceeding free | $0-50 |
| Helius mainnet RPC (upstream for `helius` endpoint slug) | ~5M req/mo | $0-50 |
| Mainnet SOL for tx fees | ~0.045 SOL/mo at beta | <$10 |

---

## 7. Rollback

### 7.1 Settler bug surfaces post-launch

Pause everything via `pause_protocol`:

```bash
# from Rick's laptop with upgrade-authority keypair
cd scripts/mainnet
DRY_RUN=1 bun pause-protocol --paused 1   # script TBD
bun pause-protocol --paused 1
```

While paused:
- Every `settle_batch` rejects with `ProtocolPaused (6032)`
- Settler logs the error, nacks; Pub/Sub redelivers; settler keeps trying
- Pub/Sub queue grows but messages don't drop until DLQ depth (10 redeliveries)
- Agents can still call wrap → market-proxy → upstream; they're charged a premium that just doesn't get processed on-chain
- **Recommend also setting `DEMO_BREACH_ALLOWLIST=""` and consider taking market-proxy down too if the bug is in pricing/classification rather than settlement**

Then deploy a fix:

```bash
gh workflow run deploy-pact-network.yaml -f environment=production -f service_name=pact-settler
# wait for new revision
bun pause-protocol --paused 0   # unpause
```

### 7.2 Cloud Run revision rollback (no on-chain bug)

```bash
gcloud run revisions list --service=pact-settler --region=asia-southeast1
gcloud run services update-traffic pact-settler \
  --to-revisions=pact-settler-00002-abc=100 \
  --region=asia-southeast1
```

### 7.3 Cloud SQL rollback

Daily backups at 02:00. Point-in-time recovery to any second within retention window. **Test this before launch.** A failed restore at 4am on day 3 of launch would be very bad.

```bash
gcloud sql instances clone pact-network-prod-db pact-network-prod-db-restore \
  --point-in-time=2026-05-XXTYY:ZZ:00.000Z
```

### 7.4 Mainnet program rollback

NOT a one-step operation. Options:

1. Pause via `pause_protocol`, deploy a fixed binary using upgrade authority, unpause:
   ```bash
   solana program deploy --program-id ~/pact-mainnet-keys/pact-network-v1-program-keypair.json \
     ~/Downloads/pact_network_v1_fixed.so
   ```
   Solana auto-replaces the binary atomically; no data migration needed if `ProtocolConfig` byte layout unchanged.

2. If a layout change is required (new fields added in middle of struct), deploy a NEW program ID and re-init. Old program orphans; off-chain config swaps to new ID.

3. Last resort: revoke the upgrade authority entirely (`solana program set-upgrade-authority`) — turns the program immutable. Don't do this until V1 is battle-tested.

---

## 8. Pre-launch dry-run checklist

Run this before flipping DNS:

- [ ] `terraform apply` in `~/devops/terraform-gcp/pact-network-prod/` succeeded; `terraform output lb_ip` returns an IP.
- [ ] All 5 secret values pushed via `gcloud secrets versions add` (Alchemy API key, Helius API key, settlement-authority JSON, indexer push secret, db password). Confirm with `gcloud secrets versions list <NAME> --project=pact-network-prod`.
- [ ] First-time deploy of each service via `deploy-pact-network.yaml` includes `--set-secrets` to bind secret env vars. (One-shot — bindings persist across future deploys.)
- [ ] All 3 Cloud Run services deployed, health checks pass:
  ```bash
  curl -H "Host: api.pactnetwork.io" https://<LB_IP> -k
  curl -H "Host: indexer.pactnetwork.io" https://<LB_IP> -k
  gcloud run services proxy pact-settler --region=asia-southeast1   # internal — needs proxy
  ```
- [ ] Cloud SQL reachable from indexer (check Prisma `migrate deploy` ran — look for "Migration applied" in indexer cold-start logs).
- [ ] Pub/Sub topic + subscription exist (created by Terraform); settler logs "subscribed to pact-settle-events-settler".
- [ ] Secret Manager: settler can read settlement-authority (check `gcloud logs` for `Treasury vault resolved` — proves keypair loaded).
- [ ] market-proxy → Pub/Sub publish: send a test classified event, confirm it lands in `pact-settle-events`.
- [ ] settler → mainnet RPC: settle a 1-event test batch (dry-run via test agent), confirm tx lands.
- [ ] settler → indexer push: verify Settlement row appears in Postgres.
- [ ] indexer → dashboard: dashboard's `/api/stats` returns non-zero counters.
- [ ] DNS records propagated (`dig api.pactnetwork.io`).
- [ ] TLS cert valid on both LB-fronted subdomains (`gcloud compute ssl-certificates list --project=pact-network-prod` shows `ACTIVE`).
- [ ] `pause_protocol(1)` smoke: pause works, all services correctly reject; unpause restores.

After all green: invite first selected user, monitor `gcloud logs tail` for an hour.

---

## 9. Outstanding work to make this real

| Item | Status |
|---|---|
| Terraform module `~/devops/terraform-gcp/pact-network-prod/` | DONE (in PR — applies pending Rick's pre-flight) |
| GH workflow `.github/workflows/build-pact-network.yaml` | DONE (in PR — `project_number` placeholder until Rick fills it) |
| GH workflow `.github/workflows/deploy-pact-network.yaml` | DONE (same) |
| `pause-protocol` script under `scripts/mainnet/` (referenced in §7.1) | TODO |
| Mainnet 10-call smoke harness (task #19) — adapt smoke-tier2 against real mainnet | TODO |
| User disclosure copy + onboarding doc (task #20) | TODO |
| GCP project provisioned (`pact-network-prod`) | NOT YET — Rick to do |
| Alchemy mainnet API key (Pact's internal Solana RPC) | NOT YET — Rick to obtain |
| Helius mainnet API key (upstream for `helius` endpoint slug) | NOT YET — Rick to obtain |
| `pactnetwork.io` DNS access | NOT YET — Rick to confirm |
| GitHub repo secrets (`ENV_PROD`, `ORG_GITHUB_TOKEN`) | NOT YET — Rick to set |

Before any of this can run, Rick needs to:
1. Create GCP project `pact-network-prod` (or fallback ID if name taken).
2. Link billing.
3. Capture `project_number` and update:
   - `~/devops/terraform-gcp/pact-network-prod/terraform.tfvars` — `project_number` and `default_compute_sa`.
   - `pact-monitor/.github/workflows/build-pact-network.yaml` — replace `TODO_FILL_AFTER_PROJECT_CREATION`.
   - `pact-monitor/.github/workflows/deploy-pact-network.yaml` — same.
4. Generate an Alchemy mainnet API key for Pact's internal Solana RPC (free tier OK for beta).
5. Generate a Helius mainnet API key for the upstream `helius` endpoint slug we proxy.
6. Confirm DNS control at `pactnetwork.io`.
7. Run `terraform init && terraform apply` in `~/devops/terraform-gcp/pact-network-prod/`.
8. Push the 5 secret values via `gcloud secrets versions add ... --data-file=-`.
8. Trigger build + deploy workflow per service. First deploy must add `--set-secrets` (one-shot — see §3 secret list).
9. Phase 2: add A records pointing both subdomains to `terraform output lb_ip`.

---

## 10. Open design questions

- **DLQ handling**: settler messages > 10 redeliveries land in `pact-settle-events-dlq`. We need a `pact-network-dlq-replayer` cron or manual procedure to inspect and decide whether to replay or drop.
- **Multi-region**: V1 single-region (`asia-southeast1`). For V2 with global agents, consider Cloud Run multi-region + Cloud SQL replica.
- **Indexer read-replica**: dashboard reads + ops queries hit the same Cloud SQL primary. Beta load is fine. At >1000 calls/min consider read replica.
- **Squads multisig timing**: per project memory, rotate upgrade authority within 2-4 weeks. Pre-stage Squads BEFORE launch even if not used immediately.
- **Force-breach control plane**: V1 has `DEMO_BREACH_ALLOWLIST` env on market-proxy + DB allowlist on the demo route. For mainnet, both must be empty. Add a CI check or runtime guard that 503s if allowlist non-empty in `NODE_ENV=production`.
