# pact-settler Cloud Run Deploy

Cloud Run deploy is blocked on Wave 0 (Pub/Sub subscription, Secret Manager secrets, service account).
Run these commands once Wave 0 infra is provisioned.

## Prerequisites

- GCP project with Pub/Sub topic `pact-settle-events` and pull subscription `pact-settle-events-settler`
- Secret Manager secret `pact-settlement-authority-devnet` containing base58-encoded settlement keypair
- Secret Manager secret `pact-indexer-push-secret` containing shared bearer token
- Service account `pact-settler@$GCP_PROJECT.iam.gserviceaccount.com` with:
  - `roles/pubsub.subscriber` on subscription `pact-settle-events-settler`
  - `roles/secretmanager.secretAccessor` on both secrets above

## 1. Create the indexer push secret (one-time)

```bash
openssl rand -hex 32 | gcloud secrets create pact-indexer-push-secret --data-file=-

# Grant settler SA access
gcloud secrets add-iam-policy-binding pact-indexer-push-secret \
  --member="serviceAccount:pact-settler@$GCP_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Grant indexer SA access to the same secret
gcloud secrets add-iam-policy-binding pact-indexer-push-secret \
  --member="serviceAccount:pact-indexer@$GCP_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## 2. Build and push image

```bash
export GCP_PROJECT=your-gcp-project-id
export GCP_REGION=us-central1
export IMAGE="gcr.io/$GCP_PROJECT/pact-settler:$(git rev-parse --short HEAD)"

# Build from monorepo root (Dockerfile copies workspace files)
docker build -f packages/settler/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"
```

## 3. Deploy to Cloud Run

```bash
export SOLANA_RPC_URL=https://api.devnet.solana.com
export PROGRAM_ID=DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc
export INDEXER_URL=https://indexer.pactnetwork.io

gcloud run deploy pact-settler \
  --image="$IMAGE" \
  --region="$GCP_REGION" \
  --service-account="pact-settler@$GCP_PROJECT.iam.gserviceaccount.com" \
  --set-env-vars="PUBSUB_PROJECT=$GCP_PROJECT,PUBSUB_SUBSCRIPTION=pact-settle-events-settler,SOLANA_RPC_URL=$SOLANA_RPC_URL,PROGRAM_ID=$PROGRAM_ID,INDEXER_URL=$INDEXER_URL,LOG_LEVEL=log" \
  --set-secrets="SETTLEMENT_AUTHORITY_KEY=pact-settlement-authority-devnet:latest,INDEXER_PUSH_SECRET=pact-indexer-push-secret:latest" \
  --no-allow-unauthenticated \
  --min-instances=1 \
  --max-instances=2 \
  --memory=512Mi \
  --cpu-always-allocated
```

## 4. Smoke test

```bash
# Temporarily allow unauthenticated for health check, then revert
SERVICE_URL=$(gcloud run services describe pact-settler --region=$GCP_REGION --format='value(status.url)')
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$SERVICE_URL/health"
# Expected: {"status":"ok","lag_ms":null}

curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$SERVICE_URL/metrics"
# Expected: Prometheus text format with settler_* metrics
```
