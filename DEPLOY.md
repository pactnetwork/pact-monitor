# pact-proxy Cloud Run Deploy

Blocked on Wave 0 (GCP project + service account provisioning). Run these steps once Wave 0 captain confirms:
- Artifact Registry repo created
- Service account `pact-proxy@<GCP_PROJECT>.iam.gserviceaccount.com` created with Pub/Sub Publisher + Cloud SQL Client roles
- Cloud SQL Postgres instance provisioned (or Cloud SQL Auth Proxy configured)

## Prerequisites

```bash
# 1. Create the endpoint reload secret
openssl rand -hex 32 | gcloud secrets create pact-endpoints-reload-token --data-file=-

# 2. Grant proxy service account access to the secret
gcloud secrets add-iam-policy-binding pact-endpoints-reload-token \
  --member="serviceAccount:pact-proxy@$GCP_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## Deploy script

```bash
#!/usr/bin/env bash
set -euo pipefail

# Required env: GCP_PROJECT, GCP_REGION, ARTIFACT_REGISTRY, CLOUDSQL_INSTANCE,
#               PG_URL, RPC_URL, PROGRAM_ID

IMAGE="$ARTIFACT_REGISTRY/proxy:$(git rev-parse --short HEAD)"

docker build --platform=linux/amd64 -f packages/proxy/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"

gcloud run deploy pact-proxy \
  --image="$IMAGE" \
  --region="$GCP_REGION" \
  --platform=managed \
  --service-account="pact-proxy@$GCP_PROJECT.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$CLOUDSQL_INSTANCE" \
  --set-env-vars="PG_URL=$PG_URL,RPC_URL=$RPC_URL,PROGRAM_ID=$PROGRAM_ID,PUBSUB_PROJECT=$GCP_PROJECT,PUBSUB_TOPIC=pact-settle-events" \
  --set-secrets="ENDPOINTS_RELOAD_TOKEN=pact-endpoints-reload-token:latest" \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=10 \
  --memory=512Mi
```

Save the above as `scripts/deploy-proxy.sh` and run:

```bash
chmod +x scripts/deploy-proxy.sh
bash scripts/deploy-proxy.sh
```

## Smoke test

```bash
curl https://pact-proxy-<hash>.run.app/health
# Expected: {"status":"ok","version":"v1","endpoints_loaded":<n>,"cache_size":0}
```

## Environment variables summary

| Var | Description |
|-----|-------------|
| `PG_URL` | Postgres connection string (Cloud SQL Auth Proxy socket or TCP) |
| `RPC_URL` | Solana RPC endpoint (Helius or QuickNode devnet/mainnet) |
| `PROGRAM_ID` | Pact Market program address (32+ char base58) |
| `PUBSUB_PROJECT` | GCP project ID |
| `PUBSUB_TOPIC` | Pub/Sub topic name (`pact-settle-events`) |
| `ENDPOINTS_RELOAD_TOKEN` | Bearer token for `/admin/reload-endpoints` (from Secret Manager) |
| `PORT` | HTTP port (default 8080, Cloud Run sets this automatically) |
