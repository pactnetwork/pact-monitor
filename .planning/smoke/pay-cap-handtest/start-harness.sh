#!/usr/bin/env bash
# Bring up the full local hand-test harness for the C-1 refund-cap test:
#   1. Postgres + Pub/Sub emulator (docker)
#   2. Apply @pact-network/db Prisma schema (prisma db push) + seed pay-default pool
#   3. Create the Pub/Sub topic + subscription
#   4. Start the LIVE facilitator (tsx) with the abuse gate OFF, log -> facilitator.log
#
# Idempotent: re-running recreates containers and re-seeds. Requires: docker,
# pnpm (repo deps installed + @pact-network/wrap built), node.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
source "$HERE/harness.env"
LOG="$HERE/facilitator.log"
PIDFILE="$HERE/facilitator.pid"
ART="$HERE/artifacts"
mkdir -p "$ART"

echo "== [1/4] docker: Postgres + Pub/Sub emulator =="
docker rm -f "$PG_CONTAINER" "$PUBSUB_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PG_CONTAINER" -e POSTGRES_USER=pact -e POSTGRES_PASSWORD=pact \
  -e POSTGRES_DB=pact -p 5544:5432 postgres:16-alpine >/dev/null
docker run -d --name "$PUBSUB_CONTAINER" -p 8685:8685 \
  gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
  gcloud beta emulators pubsub start --host-port=0.0.0.0:8685 --project="$PUBSUB_PROJECT" >/dev/null
echo "   waiting for Postgres..."
for i in $(seq 1 30); do docker exec "$PG_CONTAINER" pg_isready -U pact >/dev/null 2>&1 && break; sleep 1; done
echo "   waiting for Pub/Sub emulator..."
for i in $(seq 1 30); do docker logs "$PUBSUB_CONTAINER" 2>&1 | grep -q "Server started" && break; sleep 1; done

echo "== [2/4] prisma db push + seed pay-default =="
( cd "$REPO/packages/db" && PG_URL="$PG_URL" pnpm exec prisma db push --skip-generate )
docker exec -e PGPASSWORD=pact "$PG_CONTAINER" psql -U pact -d pact -c \
"INSERT INTO \"Endpoint\" (slug, network, \"flatPremiumLamports\", \"percentBps\", \"slaLatencyMs\", \"imputedCostLamports\", \"exposureCapPerHourLamports\", paused, \"upstreamBase\", \"displayName\", \"registeredAt\", \"lastUpdated\") VALUES ('pay-default','solana-devnet',1000,0,10000,1000000,5000000,false,'https://pay.local','Pay Default', now(), now()) ON CONFLICT (network, slug) DO UPDATE SET \"flatPremiumLamports\"=excluded.\"flatPremiumLamports\", \"imputedCostLamports\"=excluded.\"imputedCostLamports\";" \
  | tee "$ART/db-seed.out"

echo "== [3/4] create Pub/Sub topic + subscription =="
( cd "$REPO/packages/facilitator" && PUBSUB_EMULATOR_HOST="$PUBSUB_EMULATOR_HOST" node --input-type=module -e '
import { PubSub } from "@google-cloud/pubsub";
const ps = new PubSub({ projectId: process.env.PUBSUB_PROJECT || "pact-handtest" });
const [t] = await ps.topic(process.env.PUBSUB_TOPIC || "pact-settle-events").get({ autoCreate: true });
const [s] = await t.subscription(process.env.PUBSUB_SUB || "handtest-sub").get({ autoCreate: true });
console.log("topic:", t.name); console.log("subscription:", s.name);
' ) | tee "$ART/pubsub-setup.out"

echo "== [4/4] start facilitator (gate=$PACT_VERDICT_ATTESTATION_GATE) -> $LOG =="
: > "$LOG"
( cd "$REPO/packages/facilitator" && \
  PG_URL="$PG_URL" RPC_URL="$RPC_URL" PROGRAM_ID="$PROGRAM_ID" USDC_MINT="$USDC_MINT" \
  PUBSUB_PROJECT="$PUBSUB_PROJECT" PUBSUB_TOPIC="$PUBSUB_TOPIC" PUBSUB_EMULATOR_HOST="$PUBSUB_EMULATOR_HOST" \
  PAY_DEFAULT_SLUG="$PAY_DEFAULT_SLUG" PACT_VERDICT_ATTESTATION_GATE="$PACT_VERDICT_ATTESTATION_GATE" PORT="$PORT" \
  pnpm exec tsx src/index.ts >> "$LOG" 2>&1 & echo $! > "$PIDFILE" )
echo "   facilitator PID $(cat "$PIDFILE")"
echo "   waiting for /health..."
for i in $(seq 1 30); do curl -sf "$FACILITATOR_URL/health" >/dev/null 2>&1 && { echo "   facilitator healthy"; break; }; sleep 1; done
curl -s "$FACILITATOR_URL/health" && echo
echo "DONE. Run: bash $HERE/call-cap-test.sh"
