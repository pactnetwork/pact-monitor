# Indexer Deploy Guide (Wave 1D.6 / 1D.7)

Blocked on Wave 0 (Cloud SQL instance, Cloud Run service account, Secret Manager entries).
Run these steps after Wave 0 captain confirms infra is ready.

## Prerequisites

- `gcloud` authenticated with project access
- Cloud SQL instance name in `$CLOUDSQL_INSTANCE` (e.g. `pact-network:us-central1:pact-db`)
- `$PG_URL` = Cloud SQL connection string (via Auth Proxy)
- `$INDEXER_PUSH_SECRET` = shared bearer secret (store in Secret Manager as `indexer-push-secret`)

## 1D.7: Apply Prisma migration to Cloud SQL

Start the Cloud SQL Auth Proxy locally:

```bash
cloud-sql-proxy $CLOUDSQL_INSTANCE --port=5432 &
```

Apply the migration (uses `prisma migrate deploy`, NOT `migrate dev`):

```bash
cd packages/db
PG_URL="postgresql://postgres:<PASSWORD>@localhost:5432/pact_indexer" pnpm prisma migrate deploy
```

Verify 7 tables exist:

```bash
psql "postgresql://postgres:<PASSWORD>@localhost:5432/pact_indexer" -c "\dt"
```

Expected tables: `Agent`, `Call`, `DemoAllowlist`, `Endpoint`, `OperatorAllowlist`, `PoolState`, `Settlement`.

Stop the proxy:

```bash
kill %1
```

## 1D.6: Deploy to Cloud Run

Build and push the image (run from repo root):

```bash
IMAGE=gcr.io/$GCP_PROJECT/pact-indexer:$(git rev-parse --short HEAD)

docker build -f packages/indexer/Dockerfile -t $IMAGE .
docker push $IMAGE
```

Deploy to Cloud Run:

```bash
gcloud run deploy pact-indexer \
  --image=$IMAGE \
  --region=us-central1 \
  --platform=managed \
  --min-instances=0 \
  --max-instances=5 \
  --port=3001 \
  --service-account=pact-indexer@$GCP_PROJECT.iam.gserviceaccount.com \
  --add-cloudsql-instances=$CLOUDSQL_INSTANCE \
  --set-secrets="PG_URL=pact-indexer-pg-url:latest,INDEXER_PUSH_SECRET=indexer-push-secret:latest" \
  --set-env-vars="NODE_ENV=production" \
  --allow-unauthenticated
```

Verify:

```bash
curl https://$(gcloud run services describe pact-indexer --region=us-central1 --format='value(status.url)')/health
# Expected: {"status":"ok"}
```

## Environment variables

| Variable | Source | Notes |
|---|---|---|
| `PG_URL` | Secret Manager `pact-indexer-pg-url` | Cloud SQL socket path for Cloud Run |
| `INDEXER_PUSH_SECRET` | Secret Manager `indexer-push-secret` | Shared with settler |
| `SOLANA_RPC_URL` | Env var | Devnet RPC (for ops tx building at Wave 2) |
| `PROGRAM_ID` | Env var | pact-market-pinocchio program ID |
