#!/usr/bin/env bash
# 04-run-stack.sh — start the off-chain stack (pubsub emulator, indexer, settler).
#
# Each service is started in the background; PIDs are written to .smoke-state/
# so 04b-stop-stack.sh can clean up. Logs land in .logs/.
#
# REQUIREMENTS
#   - Postgres on localhost:5433 (docker-compose.dev.yml)
#   - 02-init-protocol.ts has run (state.json populated)
#   - The indexer + settler packages (and their workspace deps) are installed.
#     If only feat/pact-market-settler is checked out, the indexer source is
#     extracted from origin/feat/pact-market-indexer into a sibling tree.
#
# USAGE
#   bash scripts/smoke-tier2/04-run-stack.sh

set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SMOKE_DIR/../.." && pwd)"
LOGS_DIR="$SMOKE_DIR/.logs"
STATE_DIR="$SMOKE_DIR/.smoke-state"
KEYS_DIR="$SMOKE_DIR/.smoke-keys"
mkdir -p "$LOGS_DIR" "$STATE_DIR"

PUBSUB_PROJECT="pact-smoke"
PUBSUB_TOPIC="pact-settle-events"
PUBSUB_SUBSCRIPTION="pact-settle-events-settler"
PUBSUB_HOST="127.0.0.1:8085"
INDEXER_PORT=3091
INDEXER_PUSH_SECRET="smoke-test-secret-do-not-use-in-prod"

# 1. Pub/Sub emulator (Docker — snap-installed gcloud can't install components)
if ! docker ps --filter name=pact-smoke-pubsub --filter status=running --quiet | grep -q .; then
  docker rm -f pact-smoke-pubsub 2>/dev/null || true
  echo "Starting Pub/Sub emulator (docker) on $PUBSUB_HOST"
  docker run --rm -d -p 8085:8085 --name pact-smoke-pubsub \
    gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
    /bin/sh -c 'gcloud beta emulators pubsub start --host-port=0.0.0.0:8085' \
    > "$LOGS_DIR/pubsub-docker.log" 2>&1
  echo "docker:pact-smoke-pubsub" > "$STATE_DIR/pubsub.pid"
  echo "Waiting for Pub/Sub emulator..."
  for i in {1..30}; do
    if curl -fsS "http://$PUBSUB_HOST/" >/dev/null 2>&1; then break; fi
    sleep 1
  done
else
  echo "Pub/Sub emulator already running"
fi
export PUBSUB_EMULATOR_HOST="$PUBSUB_HOST"
export PUBSUB_PROJECT_ID="$PUBSUB_PROJECT"

# 2. Create topic + subscription on the emulator
echo "Provisioning topic $PUBSUB_TOPIC + subscription $PUBSUB_SUBSCRIPTION"
PUBSUB_BASE="http://$PUBSUB_HOST/v1/projects/$PUBSUB_PROJECT"
curl -fsS -X PUT "$PUBSUB_BASE/topics/$PUBSUB_TOPIC" \
  -H 'content-type: application/json' \
  -d '{}' > /dev/null 2>&1 || true
curl -fsS -X PUT "$PUBSUB_BASE/subscriptions/$PUBSUB_SUBSCRIPTION" \
  -H 'content-type: application/json' \
  -d "{\"topic\": \"projects/$PUBSUB_PROJECT/topics/$PUBSUB_TOPIC\", \"ackDeadlineSeconds\": 60}" > /dev/null 2>&1 || true

# 3. Pull state.json values that downstream services need
PROGRAM_ID=$(node -e "console.log(require('$STATE_DIR/state.json').programId)")
SETTLER_KEYPAIR_BASE58=$(node -e "
  const fs=require('fs');
  const bs58=require('bs58');
  const a=JSON.parse(fs.readFileSync('$KEYS_DIR/settlement-authority.json'));
  console.log(bs58.default.encode(Uint8Array.from(a)));
")
echo "PROGRAM_ID=$PROGRAM_ID"

# 4. If indexer source is missing, pull it from origin/feat/pact-market-indexer.
INDEXER_DIR="$REPO_ROOT/packages/indexer"
DB_DIR="$REPO_ROOT/packages/db"
if [[ ! -f "$INDEXER_DIR/src/events/events.controller.ts" ]] || ! grep -q "pact-network/db" "$INDEXER_DIR/package.json" 2>/dev/null; then
  echo "Indexer source missing — extracting from origin/feat/pact-market-indexer"
  TMP=$(mktemp -t pactindex.XXXXXX.tar)
  git -C "$REPO_ROOT" archive origin/feat/pact-market-indexer \
    packages/indexer packages/db > "$TMP"
  tar -xf "$TMP" -C "$REPO_ROOT" --overwrite
  rm -f "$TMP"
fi

# 5. Install dependencies + build dependencies (one-time, cached)
if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "Installing pnpm workspace deps"
  ( cd "$REPO_ROOT" && pnpm install --prefer-offline 2>&1 | tee "$LOGS_DIR/install.log" )
fi

# 6. Migrate DB
export PG_URL="postgresql://pact:pact@localhost:5433/pact"
export DATABASE_URL="$PG_URL"
echo "Running prisma migrate deploy"
( cd "$DB_DIR" && pnpm exec prisma migrate deploy 2>&1 | tee "$LOGS_DIR/prisma-migrate.log" )

# 7. Build indexer + settler + protocol-v1-client
echo "Building protocol-v1-client + db + indexer + settler"
( cd "$REPO_ROOT" && pnpm --filter @pact-network/db --filter @pact-network/protocol-v1-client run build 2>&1 | tee "$LOGS_DIR/build-libs.log" )
( cd "$REPO_ROOT" && pnpm --filter @pact-network/indexer run build 2>&1 | tee "$LOGS_DIR/build-indexer.log" )
( cd "$REPO_ROOT" && pnpm --filter @pact-network/settler run build 2>&1 | tee "$LOGS_DIR/build-settler.log" )

# 8. Start indexer
echo "Starting indexer on :$INDEXER_PORT"
(
  cd "$INDEXER_DIR"
  PORT=$INDEXER_PORT \
  PG_URL="$PG_URL" \
  DATABASE_URL="$PG_URL" \
  INDEXER_PUSH_SECRET="$INDEXER_PUSH_SECRET" \
    node dist/main.js > "$LOGS_DIR/indexer.log" 2>&1 &
  echo $! > "$STATE_DIR/indexer.pid"
)

# Wait for indexer health
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:$INDEXER_PORT/health" >/dev/null 2>&1; then
    echo "Indexer healthy"
    break
  fi
  sleep 1
done

# 9. Start settler
SETTLER_DIR="$REPO_ROOT/packages/settler"
echo "Starting settler"
(
  cd "$SETTLER_DIR"
  PUBSUB_PROJECT="$PUBSUB_PROJECT" \
  PUBSUB_SUBSCRIPTION="$PUBSUB_SUBSCRIPTION" \
  PUBSUB_EMULATOR_HOST="$PUBSUB_HOST" \
  SOLANA_RPC_URL="http://127.0.0.1:8899" \
  SETTLEMENT_AUTHORITY_KEY="$SETTLER_KEYPAIR_BASE58" \
  PROGRAM_ID="$PROGRAM_ID" \
  USDC_MINT="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" \
  INDEXER_URL="http://127.0.0.1:$INDEXER_PORT" \
  INDEXER_PUSH_SECRET="$INDEXER_PUSH_SECRET" \
  PORT=8080 \
    node dist/main.js > "$LOGS_DIR/settler.log" 2>&1 &
  echo $! > "$STATE_DIR/settler.pid"
)

sleep 5
echo "Stack up. PIDs:"
[[ -f "$STATE_DIR/pubsub.pid" ]] && echo "  pubsub: $(cat "$STATE_DIR/pubsub.pid")"
echo "  indexer: $(cat "$STATE_DIR/indexer.pid")"
echo "  settler: $(cat "$STATE_DIR/settler.pid")"
echo "  logs in $LOGS_DIR/"
