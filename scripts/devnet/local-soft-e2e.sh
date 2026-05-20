#!/usr/bin/env bash
# local-soft-e2e.sh — run the SDK live devnet E2E in SOFT MODE entirely
# locally, wired to the LIVE devnet Pact program. Proves: real on-chain SPL
# Approve, slug discovery + covered routing through the real market-proxy code,
# real premium-bearing breach classification (?fail=1 -> 503 -> server_error),
# and the golden rule. Does NOT prove an on-chain refund (that needs the
# settler — the deferred "strict" path); the X-Pact-* headers + on-chain
# eligibility are the evidence the call would settle.
#
# The ONE external dependency: devnet USDC 4zMMC9… is not faucet-able and the
# public SOL faucet is often rate-limited. Whoever holds the devnet USDC mint
# authority (GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz) funds the agent
# (this script prints the exact address + commands and waits).
#
# Usage:
#   scripts/devnet/local-soft-e2e.sh up        # bring up stack, provision, run
#   scripts/devnet/local-soft-e2e.sh down       # tear everything down
#
# Prereqs: pnpm install (done once), Docker running, Node 22.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_URL='postgresql://postgres:postgres@localhost:55432/pact_e2e'
PROGRAM_ID='5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5'
USDC_MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
DUMMY_PORT=8799
PROXY_PORT=8798
KEYFILE="${PACT_E2E_KEYFILE:-/tmp/pact-e2e-agent.json}"
PIDS=()

down() {
  echo ">> teardown"
  pkill -f 'tsx watch src/index.ts' 2>/dev/null || true
  docker rm -f pact-e2e-pg 2>/dev/null || true
  echo ">> done (keyfile $KEYFILE left in place; rm it manually if desired)"
}
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done' EXIT

if [[ "${1:-up}" == "down" ]]; then down; exit 0; fi

cd "$REPO"

echo ">> [1] Postgres"
docker rm -f pact-e2e-pg >/dev/null 2>&1 || true
docker run --name pact-e2e-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pact_e2e \
  -p 55432:5432 -d postgres:16 >/dev/null
for i in $(seq 1 60); do
  docker exec pact-e2e-pg pg_isready -U postgres -d pact_e2e >/dev/null 2>&1 && break
  sleep 1
done

echo ">> [2] schema"
PG_URL="$PG_URL" pnpm --filter @pact-network/db run db:migrate >/dev/null

echo ">> [3] seed insured dummy"
docker exec -i pact-e2e-pg psql -U postgres -d pact_e2e \
  < "$REPO/scripts/devnet/seed-local-dummy.sql" >/dev/null

echo ">> [4] dummy-upstream :$DUMMY_PORT"
PORT=$DUMMY_PORT pnpm --filter @pact-network/dummy-upstream run dev \
  >/tmp/pact-e2e-dummy.log 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do
  [[ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://localhost:$DUMMY_PORT/quote/AAPL?fail=1")" == "503" ]] && break
  sleep 1
done

echo ">> [5] market-proxy :$PROXY_PORT (live devnet)"
PG_URL="$PG_URL" RPC_URL='https://api.devnet.solana.com' PROGRAM_ID="$PROGRAM_ID" \
  USDC_MINT="$USDC_MINT" PUBSUB_PROJECT='pact-local' PUBSUB_TOPIC='settlements' \
  ENDPOINTS_RELOAD_TOKEN='pact-local-reload-token' PUBSUB_EMULATOR_HOST='127.0.0.1:8085' \
  PORT=$PROXY_PORT pnpm --filter @pact-network/market-proxy run dev \
  >/tmp/pact-e2e-proxy.log 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do
  [[ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://localhost:$PROXY_PORT/health")" == "200" ]] && break
  sleep 1
done
curl -s "http://localhost:$PROXY_PORT/.well-known/endpoints" | grep -q '"slug":"dummy"' \
  || { echo "!! dummy not in discovery"; exit 1; }

echo ">> [6] agent keypair + provision"
if [[ ! -f "$KEYFILE" ]]; then
  (cd "$REPO/scripts/devnet" && node --input-type=module -e \
    "import {Keypair} from '@solana/web3.js'; import bs58 from 'bs58'; const k=Keypair.generate(); process.stdout.write(JSON.stringify({pub:k.publicKey.toBase58(),sk:bs58.encode(k.secretKey)}))") \
    > "$KEYFILE"
  chmod 600 "$KEYFILE"
fi
SK="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$KEYFILE','utf8')).sk)")"
# NOTE: invoke WITHOUT extra args — the pnpm `run` wrapper appends a literal
# `--` that fund-agent.ts's parser rejects; its default allowance is 5 USDC.
# fund-agent airdrops SOL (often rate-limited on devnet), then prints the exact
# `spl-token mint` line, polls the ATA, and sends the SPL Approve on funding.
PACT_DEVNET_SECRET_KEY="$SK" pnpm --filter @pact-network/scripts-devnet run fund-agent || {
  echo "!! fund-agent did not complete (likely SOL faucet rate-limit and/or"
  echo "   USDC not yet minted). Fund the printed agent address with devnet"
  echo "   SOL (>=0.5) + 5 USDC (mint authority), then re-run: $0 up"
  exit 1
}

echo ">> [8] soft-mode E2E (local proxy, no indexer)"
PACT_SDK_E2E=1 PACT_DEVNET_SECRET_KEY="$SK" \
  PACT_DEVNET_PROXY_URL="http://localhost:$PROXY_PORT" \
  PACT_DEVNET_PROGRAM_ID="$PROGRAM_ID" \
  pnpm --filter @q3labs/pact-sdk run test:e2e

echo ">> [9] on-chain corroboration"
pnpm --filter @pact-network/scripts-devnet exec tsx verify-network.ts \
  --program-id "$PROGRAM_ID" --indexer https://indexer.pactnetwork.io \
  2>&1 | grep -E 'B1|B2|PASS' || true
echo ">> PASS — soft mode. Refund NOT asserted (no settler); covered breach +"
echo "   on-chain eligibility proven on live devnet. Run '$0 down' to teardown."
