# Pact Network V1 — Mainnet Cloud Run Deploy Plan

Comprehensive operational runbook for shipping the V1 off-chain stack to GCP Cloud Run for mainnet.

**Status:** plan, not yet executed. PRs needed for new GH Actions workflows tracked at the bottom.

**Audience:** the operator running the deploy (Rick + Claude).

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
│  Cloud Run: market-proxy        Public — api.pactnetwork.io           │
│  - Hono on Node 22, asia-southeast1                                    │
│  - Wraps Helius / Birdeye / Jupiter / Elfa / fal.ai upstreams         │
│  - Classifies, charges premium via SPL Token CPI                       │
│  - Publishes settle events to Pub/Sub                                  │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  Pub/Sub publish
                ┌─────────────────────────────────┐
                │  Pub/Sub topic: pact-settle-events│
                │  + subscription: settler          │
                └─────────────────────────────────┘
                              │
                              ▼  Pub/Sub pull
┌────────────────────────────────────────────────────────────────────────┐
│  Cloud Run: settler              Internal — no public ingress          │
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
   │ Solana mainnet   │                  │ Cloud Run: indexer             │
   │ - Helius free    │                  │ - NestJS, asia-southeast1      │
   │ - api.mainnet... │                  │ - Public read API at           │
   │ (HA via Helius   │                  │   indexer.pactnetwork.io       │
   │  + fallback)     │                  │ - Connects to Cloud SQL        │
   └──────────────────┘                  └────────────────────────────────┘
                                                          │
                                                          ▼
                                           ┌────────────────────────────────┐
                                           │ Cloud SQL: pact-mainnet-pg     │
                                           │ - Postgres 16, db-f1-micro     │
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
- **market-proxy** → Cloud Run (public)
- **settler** → Cloud Run (private, no ingress)
- **indexer** → Cloud Run (public read API)
- **market-dashboard** → Vercel (public)
- **postgres** → Cloud SQL (private)

Plus three GCP-managed resources: Pub/Sub topic + subscription, Secret Manager (for settlement-authority keypair), and Cloud SQL.

---

## 2. Pre-flight checklist

### 2.1 GCP project

Create or pick the production GCP project. **Do not reuse the staging project (`staging-apps-482206`).**

```bash
gcloud projects create pact-mainnet-prod --name="Pact Network Mainnet" --no-enable-cloud-apis
gcloud config set project pact-mainnet-prod
PROJECT_ID=pact-mainnet-prod
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

# Link billing
gcloud beta billing accounts list
gcloud beta billing projects link $PROJECT_ID --billing-account=<ACCOUNT_ID>
```

### 2.2 Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  pubsub.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  servicenetworking.googleapis.com \
  vpcaccess.googleapis.com \
  cloudbuild.googleapis.com
```

### 2.3 Region

All in `asia-southeast1` to match staging convention. If user latency from US/EU matters more for mainnet beta, consider `us-central1`.

```bash
REGION=asia-southeast1
```

### 2.4 Artifact Registry repos

One repo per service:

```bash
for svc in market-proxy settler indexer; do
  gcloud artifacts repositories create pact-$svc \
    --repository-format=docker \
    --location=$REGION \
    --description="Pact Network V1 $svc"
done
```

### 2.5 VPC + private services

For Cloud SQL private IP and VPC access connector (so settler/indexer reach Cloud SQL):

```bash
# Default VPC is fine
gcloud compute networks vpc-access connectors create pact-connector \
  --network=default \
  --region=$REGION \
  --range=10.8.0.0/28
```

Reserve a private services range:

```bash
gcloud compute addresses create google-managed-services-default \
  --global \
  --purpose=VPC_PEERING \
  --prefix-length=16 \
  --network=default

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-default \
  --network=default
```

### 2.6 Cloud SQL

```bash
gcloud sql instances create pact-mainnet-pg \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=$REGION \
  --network=projects/$PROJECT_ID/global/networks/default \
  --no-assign-ip \
  --storage-size=10GB \
  --storage-type=SSD \
  --backup-start-time=02:00

gcloud sql databases create pact --instance=pact-mainnet-pg
gcloud sql users create pact --instance=pact-mainnet-pg --password=<STRONG_PASSWORD>
```

Capture: instance name, private IP, password (store in Secret Manager — see 2.8).

`db-f1-micro` is the smallest tier. Beta load is fine. Plan to upgrade to `db-custom-1-3840` post-launch when call volume rises.

### 2.7 Pub/Sub topic + subscription

```bash
gcloud pubsub topics create pact-settle-events

gcloud pubsub subscriptions create pact-settle-events-settler \
  --topic=pact-settle-events \
  --ack-deadline=60 \
  --message-retention-duration=7d \
  --max-delivery-attempts=10 \
  --dead-letter-topic=pact-settle-events-dlq
gcloud pubsub topics create pact-settle-events-dlq
```

Settler consumes `pact-settle-events-settler`. Failed batches > 10 retries land in `pact-settle-events-dlq` for manual inspection.

### 2.8 Secret Manager — settlement-authority + DB password

The settler service signs `settle_batch` txs with the settlement-authority keypair. It MUST live in Secret Manager, never in env files or container images.

```bash
# After running scripts/mainnet/init-mainnet.ts on Rick's laptop:
gcloud secrets create pact-mainnet-settlement-authority --replication-policy=automatic
gcloud secrets versions add pact-mainnet-settlement-authority \
  --data-file=/path/to/settlement-authority.json

# DB password
echo -n "<DB_PASSWORD>" | gcloud secrets create pact-mainnet-db-password \
  --replication-policy=automatic --data-file=-

# Indexer push secret (for settler→indexer auth)
openssl rand -hex 32 | tee /tmp/indexer-push-secret | \
  gcloud secrets create pact-mainnet-indexer-push-secret \
  --replication-policy=automatic --data-file=-
# settler reads this; indexer reads same value to validate
```

Grant the service accounts read access (after creating SAs in 2.9):

```bash
for sa in settler-sa indexer-sa; do
  gcloud secrets add-iam-policy-binding pact-mainnet-settlement-authority \
    --member=serviceAccount:$sa@$PROJECT_ID.iam.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor 2>/dev/null || true  # only settler needs this
done

gcloud secrets add-iam-policy-binding pact-mainnet-settlement-authority \
  --member=serviceAccount:settler-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding pact-mainnet-db-password \
  --member=serviceAccount:indexer-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding pact-mainnet-indexer-push-secret \
  --member=serviceAccount:settler-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding pact-mainnet-indexer-push-secret \
  --member=serviceAccount:indexer-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

### 2.9 Service accounts

Per-service SA for least-privilege:

```bash
for svc in market-proxy settler indexer; do
  gcloud iam service-accounts create $svc-sa \
    --display-name="Cloud Run $svc"
done

# settler: publish nothing, subscribe to pact-settle-events-settler
gcloud pubsub subscriptions add-iam-policy-binding pact-settle-events-settler \
  --member=serviceAccount:settler-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/pubsub.subscriber

# market-proxy: publish only
gcloud pubsub topics add-iam-policy-binding pact-settle-events \
  --member=serviceAccount:market-proxy-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/pubsub.publisher

# indexer: connect to Cloud SQL
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:indexer-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/cloudsql.client
```

### 2.10 GitHub OIDC (Workload Identity Federation)

To deploy from GH Actions without service-account-key files:

```bash
gcloud iam workload-identity-pools create wif-mainnet-pool \
  --location=global

gcloud iam workload-identity-pools providers create-oidc wif-mainnet-provider \
  --location=global \
  --workload-identity-pool=wif-mainnet-pool \
  --display-name="GitHub OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='pactnetwork/pact-monitor'" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# Bind a deployer SA that GH Actions can impersonate
gcloud iam service-accounts create gh-pact-mainnet-deployer-sa
gcloud iam service-accounts add-iam-policy-binding \
  gh-pact-mainnet-deployer-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/wif-mainnet-pool/attribute.repository/pactnetwork/pact-monitor"

# Grant deployer SA the roles it needs
for role in run.admin artifactregistry.writer iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:gh-pact-mainnet-deployer-sa@$PROJECT_ID.iam.gserviceaccount.com" \
    --role=roles/$role
done
```

Add to GitHub repo secrets:
- `GCP_MAINNET_PROJECT_ID` = `pact-mainnet-prod`
- `GCP_MAINNET_PROJECT_NUMBER` = (from above)
- `GCP_MAINNET_WIF_POOL` = `wif-mainnet-pool`
- `GCP_MAINNET_WIF_PROVIDER` = `wif-mainnet-provider`
- `ENV_PROD` = (the YAML env file — see §4)

---

## 3. Service deploy specs

### 3.1 market-proxy

**Image build** — `packages/market-proxy/Dockerfile` (already exists). Multi-stage Node 22 slim.

**Cloud Run config**:
- CPU: 1 (idle scale 0, min 0)
- Memory: 512Mi
- Concurrency: 80 (Hono is async-heavy)
- Max instances: 10 (cap blast radius)
- Timeout: 30s (upstream APIs may be slow)
- Ingress: `all` (public)
- VPC connector: NONE (proxy doesn't need DB; talks to upstream APIs over public internet)

**Env vars** (via `ENV_PROD` Cloud Run env file or per-service secret):

```yaml
NODE_ENV: production
SOLANA_RPC_URL: https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
PROGRAM_ID: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
USDC_MINT: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
PUBSUB_TOPIC: projects/pact-mainnet-prod/topics/pact-settle-events
GOOGLE_CLOUD_PROJECT: pact-mainnet-prod
HELIUS_UPSTREAM_URL: https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
BIRDEYE_UPSTREAM_URL: https://public-api.birdeye.so
JUPITER_UPSTREAM_URL: https://api.jup.ag
ELFA_UPSTREAM_URL: https://api.elfa.ai
FAL_UPSTREAM_URL: https://queue.fal.run
DEMO_BREACH_ALLOWLIST: ""  # empty in prod — disables force-breach
LOG_LEVEL: info
```

**Auth**: none — public endpoint. The agent provides their own wallet for SPL Token Approval.

### 3.2 settler

**Image build** — `packages/settler/Dockerfile` (NestJS multi-stage).

**Cloud Run config**:
- CPU: 2 (Solana tx signing + JSON parsing)
- Memory: 1Gi
- Concurrency: 1 (Pub/Sub processing is per-message; concurrency >1 risks duplicate batches if the same message is double-processed)
- Min instances: 1 (must be online to consume Pub/Sub continuously)
- Max instances: 3 (avoid horizontal blowup; deadlock fix B12 makes 2-3 safe)
- Timeout: 60s (settle_batch tx + indexer push round trip)
- Ingress: `internal` (no public access; only Pub/Sub triggers)
- VPC connector: NOT needed (talks to Solana RPC + indexer over HTTPS)

**Env vars**:

```yaml
NODE_ENV: production
RPC_URL: https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
PROGRAM_ID: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
USDC_MINT: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
PUBSUB_PROJECT: pact-mainnet-prod
PUBSUB_SUBSCRIPTION: pact-settle-events-settler
INDEXER_URL: https://indexer.pactnetwork.io
LOG_LEVEL: info
PORT: 8080
SETTLER_BATCH_SIZE: 3   # MAX_BATCH_SIZE from FIX-1, hard-coded but env keeps it visible
```

**Mounted secrets**:

```yaml
volumes:
  - name: settlement-authority
    secret:
      secretName: pact-mainnet-settlement-authority
      version: latest
volumeMounts:
  - name: settlement-authority
    mountPath: /secrets/settlement-authority
    readOnly: true
env:
  - name: SETTLEMENT_AUTHORITY_KEYPAIR_PATH
    value: /secrets/settlement-authority
  - name: INDEXER_PUSH_SECRET
    valueFrom:
      secretKeyRef:
        name: pact-mainnet-indexer-push-secret
        key: latest
```

**Service account**: `settler-sa@pact-mainnet-prod.iam.gserviceaccount.com`

### 3.3 indexer

**Image build** — `packages/indexer/Dockerfile`.

**Cloud Run config**:
- CPU: 1
- Memory: 512Mi
- Concurrency: 80 (read-heavy API)
- Min instances: 1 (low latency for dashboard)
- Max instances: 10
- Timeout: 30s
- Ingress: `all` (public read API)
- VPC connector: `pact-connector` (for Cloud SQL private IP)

**Env vars**:

```yaml
NODE_ENV: production
DATABASE_URL: postgresql://pact:${DB_PASSWORD}@${CLOUDSQL_PRIVATE_IP}:5432/pact?schema=public
PORT: 8080
LOG_LEVEL: info
```

**Mounted secrets**:

```yaml
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: pact-mainnet-db-password
        key: latest
  - name: INDEXER_PUSH_SECRET
    valueFrom:
      secretKeyRef:
        name: pact-mainnet-indexer-push-secret
        key: latest
```

**Service account**: `indexer-sa@pact-mainnet-prod.iam.gserviceaccount.com`

**Migration**: run `prisma migrate deploy` once during the deploy pipeline before the first revision rolls out. Use a Cloud Run Job (one-shot container) or run from a developer machine via Cloud SQL Auth Proxy.

### 3.4 market-dashboard

**NOT Cloud Run.** Deploy on Vercel — it's Next.js 15 and Vercel handles SSR/ISR/edge correctly.

**Vercel config**:

```bash
cd packages/market-dashboard
vercel link  # creates .vercel/project.json (gitignored)
vercel env add NEXT_PUBLIC_USDC_MINT production
# value: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

vercel env add NEXT_PUBLIC_INDEXER_URL production
# value: https://indexer.pactnetwork.io

vercel env add NEXT_PUBLIC_RPC_URL production
# value: https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
# (optional override; defaults to mainnet-beta)

vercel env add NEXT_PUBLIC_PROGRAM_ID production
# value: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc

vercel --prod
```

Domain: `app.pactnetwork.io` (CNAME to Vercel).

The known panel-emptiness issues (no per-call recipientShares wired into the dashboard yet) are tracked as small follow-ups; not launch-blockers for selected-users beta.

---

## 4. Env file pattern (Cloud Run `--env-vars-file`)

Existing staging uses one big `ENV_STG` GH secret containing a YAML env file. Mirror with `ENV_PROD`:

```yaml
# stored in GH secret ENV_PROD, written to /tmp/cloud-run-env.yaml in the deploy workflow
# Service-specific overrides happen via per-service `--update-env-vars` after-the-fact.

# Common
NODE_ENV: production
PROGRAM_ID: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
USDC_MINT: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
GOOGLE_CLOUD_PROJECT: pact-mainnet-prod
LOG_LEVEL: info

# market-proxy
SOLANA_RPC_URL: https://mainnet.helius-rpc.com/?api-key=...
PUBSUB_TOPIC: projects/pact-mainnet-prod/topics/pact-settle-events
HELIUS_UPSTREAM_URL: https://mainnet.helius-rpc.com/?api-key=...
BIRDEYE_UPSTREAM_URL: https://public-api.birdeye.so
JUPITER_UPSTREAM_URL: https://api.jup.ag
ELFA_UPSTREAM_URL: https://api.elfa.ai
FAL_UPSTREAM_URL: https://queue.fal.run
DEMO_BREACH_ALLOWLIST: ""

# settler
RPC_URL: https://mainnet.helius-rpc.com/?api-key=...
PUBSUB_SUBSCRIPTION: pact-settle-events-settler
INDEXER_URL: https://indexer.pactnetwork.io

# indexer
# DATABASE_URL is computed in deploy step — depends on Cloud SQL private IP
```

Per-service deploy step OVERRIDES the keys it cares about (or just lets unused keys be ignored — no harm).

---

## 5. Deploy workflow

Three new GH Actions workflows needed (currently only `deploy.yaml` for the old backend exists):

- `.github/workflows/deploy-market-proxy.yaml`
- `.github/workflows/deploy-settler.yaml`
- `.github/workflows/deploy-indexer.yaml`

All three follow the existing `deploy.yaml` pattern but with service-specific:
- `SERVICE_NAME` (`pact-market-proxy` / `pact-settler` / `pact-indexer`)
- `AR_REPO`
- `CICD_SA`
- secret mounts (only settler + indexer mount secrets; market-proxy is plain env)
- `--ingress` (all / internal / all)
- `--vpc-connector` (none / none / pact-connector)
- `--cpu`, `--memory`, `--min-instances`, `--max-instances`, `--concurrency` per §3

Use `workflow_dispatch` with `environment: production` input. Workflow performs:

1. Resolve Workload Identity Federation
2. Build Docker image, push to Artifact Registry
3. Apply Cloud Run service config (`gcloud run services replace`) with the service YAML
4. Verify deployment (health check)

Indexer additionally runs `prisma migrate deploy` against Cloud SQL via the Cloud SQL Auth Proxy in a Cloud Run Job before the new revision goes live.

Order of first-time deploy:

```
1. Cloud SQL up + reachable (manual, §2.6)
2. Pub/Sub topics + subscriptions exist (manual, §2.7)
3. Secrets created + IAM bindings (manual, §2.8)
4. Push migration:    cd packages/indexer && prisma migrate deploy
5. Deploy indexer:    gh workflow run deploy-indexer.yaml -f environment=production
6. Deploy settler:    gh workflow run deploy-settler.yaml -f environment=production
7. Deploy market-proxy: gh workflow run deploy-market-proxy.yaml -f environment=production
8. Verify:            curl https://indexer.pactnetwork.io/health
                      curl https://api.pactnetwork.io/health
9. Vercel:            cd packages/market-dashboard && vercel --prod
```

---

## 6. DNS

Three CNAMEs at `pactnetwork.io`:

| Subdomain | Points to |
|---|---|
| `api.pactnetwork.io` | Cloud Run market-proxy (`<run-url>.a.run.app`) |
| `indexer.pactnetwork.io` | Cloud Run indexer |
| `app.pactnetwork.io` | Vercel market-dashboard |

Set up Cloud Run domain mapping for the first two:

```bash
gcloud run domain-mappings create \
  --service=pact-market-proxy \
  --domain=api.pactnetwork.io \
  --region=$REGION

gcloud run domain-mappings create \
  --service=pact-indexer \
  --domain=indexer.pactnetwork.io \
  --region=$REGION
```

`gcloud run domain-mappings describe` returns the CNAME records to add at the DNS registrar (Cloudflare / Namecheap / wherever). TLS certs auto-provisioned by Cloud Run.

For Vercel, add domain in dashboard or `vercel domains add app.pactnetwork.io`.

---

## 7. Monitoring + alerts

### 7.1 Cloud Monitoring uptime checks

```bash
# market-proxy
gcloud monitoring uptime create-http \
  --display-name="market-proxy /health" \
  --resource-type=uptime-url \
  --resource-labels=host=api.pactnetwork.io \
  --request-path=/health

# indexer
gcloud monitoring uptime create-http \
  --display-name="indexer /health" \
  --resource-type=uptime-url \
  --resource-labels=host=indexer.pactnetwork.io \
  --request-path=/health
```

### 7.2 Alert policies

Critical alerts to wire (route to your phone/Slack):

| Metric | Threshold | Severity |
|---|---|---|
| settler error rate (`run.googleapis.com/request_count` filtered to 5xx) | > 5/min for 5min | high |
| settler queue depth (`pact-settle-events-settler` `num_undelivered_messages`) | > 100 for 10min | high |
| settler RPC failure rate (custom log metric on "rpc down" warns) | > 0.1/sec for 5min | medium |
| Cloud SQL CPU | > 90% for 10min | medium |
| indexer error rate | > 5/min for 5min | medium |
| Cloud Run instance crash loop (revision rollback) | any | high |

The settler emits prom-style metrics on `:8080/metrics`; scrape via the Managed Prometheus integration if you want graphs.

### 7.3 Logs

Default Cloud Logging captures stdout/stderr from all three services. Useful filters:

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

## 8. Cost estimate (per month, beta scale)

| Resource | Tier | Cost |
|---|---|---|
| market-proxy Cloud Run | min=0, scale to load | $5-20 |
| settler Cloud Run | min=1, 24/7 | $25-40 |
| indexer Cloud Run | min=1, 24/7 | $25-40 |
| Cloud SQL `db-f1-micro` | + 10GB SSD | $10-15 |
| Pub/Sub | 1M msg/mo at beta | <$1 |
| Secret Manager | 4 secrets, 1 access/min | <$1 |
| Artifact Registry | 3 repos, ~100MB each | <$1 |
| VPC connector | always-on f1-micro equivalent | $7 |
| Cloud Run egress | low at beta | $1-5 |
| Vercel hobby (dashboard) | hobby tier | $0-20 |
| **Total** | | **~$75-150/mo** |

Plus mainnet RPC if you outgrow Helius free tier (~$50/mo for 5M req).

Plus mainnet SOL for upgrade rent + tx fees: 1.5 SOL initial deploy, then ~0.0001 SOL per `settle_batch` × ~15 batches/day ≈ 0.045 SOL/month at low volume.

---

## 9. Rollback

### 9.1 Settler bug surfaces post-launch

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
gh workflow run deploy-settler.yaml -f environment=production
# wait for new revision
bun pause-protocol --paused 0   # unpause
```

### 9.2 Cloud Run revision rollback (no on-chain bug)

```bash
gcloud run revisions list --service=pact-settler --region=$REGION
gcloud run services update-traffic pact-settler \
  --to-revisions=pact-settler-00002-abc=100 \
  --region=$REGION
```

### 9.3 Cloud SQL rollback

Daily backups at 02:00. Point-in-time recovery to any second within retention window. **Test this before launch.** A failed restore at 4am on day 3 of launch would be very bad.

```bash
gcloud sql instances clone pact-mainnet-pg pact-mainnet-pg-restore \
  --point-in-time=2026-05-XXTYY:ZZ:00.000Z
```

### 9.4 Mainnet program rollback

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

## 10. Pre-launch dry-run checklist

Run this before flipping DNS:

- [ ] All 3 Cloud Run services deployed, health checks pass
- [ ] Cloud SQL reachable from indexer (check `prisma migrate deploy` ran)
- [ ] Pub/Sub topic + subscription exist; settler logs "subscribed to pact-settle-events-settler"
- [ ] Secret Manager: settler can read settlement-authority (check `gcloud logs` for `Treasury vault resolved` — proves keypair loaded)
- [ ] market-proxy → Pub/Sub publish: send a test classified event, confirm it lands in `pact-settle-events`
- [ ] settler → mainnet RPC: settle a 1-event test batch (dry-run via test agent), confirm tx lands
- [ ] settler → indexer push: verify Settlement row appears in Postgres
- [ ] indexer → dashboard: dashboard's `/api/stats` returns non-zero counters
- [ ] DNS records propagated (`dig api.pactnetwork.io`)
- [ ] TLS cert valid on all three subdomains
- [ ] `pause_protocol(1)` smoke: pause works, all services correctly reject; unpause restores

After all green: invite first selected user, monitor `gcloud logs tail` for an hour.

---

## 11. Outstanding work to make this real

| Item | Status |
|---|---|
| GH workflow `.github/workflows/deploy-market-proxy.yaml` | TODO |
| GH workflow `.github/workflows/deploy-settler.yaml` | TODO |
| GH workflow `.github/workflows/deploy-indexer.yaml` | TODO |
| `pause-protocol` script under `scripts/mainnet/` (referenced in §9.1) | TODO |
| Mainnet 10-call smoke harness (task #19) — adapt smoke-tier2 against real mainnet | TODO |
| User disclosure copy + onboarding doc (task #20) | TODO |
| GCP project provisioned (`pact-mainnet-prod`) | NOT YET — Rick to do |
| Helius mainnet API key | NOT YET — Rick to obtain |
| `pactnetwork.io` DNS access | NOT YET — Rick to confirm |

Before any of this can run, Rick needs to:
1. Create GCP project `pact-mainnet-prod` (or whatever name)
2. Link billing
3. Generate a Helius mainnet API key (free tier OK for beta)
4. Confirm DNS control at `pactnetwork.io`

Then we author the workflows + run §2 setup + §5 deploys.

---

## 12. Open design questions

- **DLQ handling**: settler messages > 10 redeliveries land in `pact-settle-events-dlq`. We need a `pact-network-dlq-replayer` cron or manual procedure to inspect and decide whether to replay or drop.
- **Multi-region**: V1 single-region (`asia-southeast1`). For V2 with global agents, consider Cloud Run multi-region + Cloud SQL replica.
- **Indexer read-replica**: dashboard reads + ops queries hit the same Cloud SQL primary. Beta load is fine. At >1000 calls/min consider read replica.
- **Squads multisig timing**: per project memory, rotate upgrade authority within 2-4 weeks. Pre-stage Squads BEFORE launch even if not used immediately.
- **Force-breach control plane**: V1 has `DEMO_BREACH_ALLOWLIST` env on market-proxy + DB allowlist on the demo route. For mainnet, both must be empty. Add a CI check or runtime guard that 503s if allowlist non-empty in `NODE_ENV=production`.
