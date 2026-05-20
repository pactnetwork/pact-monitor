#!/usr/bin/env bash
# smoke-affiliate.sh — manual smoke for the C2 affiliate-reads routes
# (GET /api/recipients/:pubkey, GET /api/recipients/:pubkey/settlements).
#
# Spins up local Postgres, runs Prisma migrations, seeds one
# Settlement + SettlementRecipientShare + RecipientEarnings triple via psql,
# starts the indexer dev server, and curls both routes asserting schema +
# cursor round-trip + zero-envelope for an unknown pubkey.
#
# This is a MANUAL smoke (not in CI) — the indexer has no Testcontainers
# harness yet (tracked separately). Run after C2 lands locally.
#
# Usage:
#   scripts/devnet/smoke-affiliate.sh up    # spin up, seed, run, teardown
#   scripts/devnet/smoke-affiliate.sh down  # force teardown only
#
# Prereqs: pnpm install (once), Docker running, Node 22.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_URL='postgresql://postgres:postgres@localhost:55433/pact_smoke_affiliate'
INDEXER_PORT=3001
INDEXER_URL="http://localhost:${INDEXER_PORT}"
KNOWN_PUBKEY='AffPubKey1111111111111111111111111111111111'
UNKNOWN_PUBKEY='ZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZz'
SIG_FAKE='SmokeSigxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
PIDS=()

cd "$REPO"

down() {
  echo ">> teardown"
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true
  done
  docker rm -f pact-smoke-affiliate-pg >/dev/null 2>&1 || true
}
trap down EXIT

case "${1:-up}" in
  down)
    down
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: $0 {up|down}" >&2
    exit 64
    ;;
esac

echo ">> [1] Postgres :55433"
docker rm -f pact-smoke-affiliate-pg >/dev/null 2>&1 || true
docker run --name pact-smoke-affiliate-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pact_smoke_affiliate \
  -p 55433:5432 -d postgres:16 >/dev/null
for _ in $(seq 1 30); do
  docker exec pact-smoke-affiliate-pg pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo ">> [2] prisma migrate deploy"
PG_URL="$PG_URL" pnpm --filter @pact-network/db run db:migrate >/dev/null

echo ">> [3] seed one Settlement + Share + RecipientEarnings"
docker exec -i pact-smoke-affiliate-pg psql -U postgres -d pact_smoke_affiliate >/dev/null <<SQL
INSERT INTO "Settlement"(signature, "batchSize", "totalPremiumsLamports", "totalRefundsLamports", ts)
VALUES ('${SIG_FAKE}', 1, 1000, 0, NOW())
ON CONFLICT (signature) DO NOTHING;

INSERT INTO "SettlementRecipientShare"(id, "settlementSig", "recipientKind", "recipientPubkey", "amountLamports")
VALUES ('cksmoke0000000000000000001', '${SIG_FAKE}', 1, '${KNOWN_PUBKEY}', 700)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "RecipientEarnings"("recipientPubkey", "recipientKind", "lifetimeEarnedLamports", "lastUpdated")
VALUES ('${KNOWN_PUBKEY}', 1, 700, NOW())
ON CONFLICT ("recipientPubkey") DO UPDATE SET "lifetimeEarnedLamports" = 700, "lastUpdated" = NOW();
SQL

echo ">> [4] indexer dev :$INDEXER_PORT"
PG_URL="$PG_URL" PORT="$INDEXER_PORT" \
  PROGRAM_ID='5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5' \
  USDC_MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' \
  SOLANA_RPC_URL='https://api.devnet.solana.com' \
  pnpm --filter @pact-network/indexer run dev >/tmp/pact-smoke-affiliate-indexer.log 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 30); do
  if curl -fsS "$INDEXER_URL/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo ">> [5] GET /api/recipients/$KNOWN_PUBKEY (lifetime — populated)"
LIFETIME=$(curl -fsS "$INDEXER_URL/api/recipients/$KNOWN_PUBKEY")
echo "    $LIFETIME"
echo "$LIFETIME" | grep -q '"lifetimeEarnedLamports":"700"' || { echo "!! expected lifetimeEarnedLamports=700"; exit 1; }
echo "$LIFETIME" | grep -q '"recipientKind":1' || { echo "!! expected recipientKind=1"; exit 1; }
echo "   PASS"

echo ">> [6] GET /api/recipients/$UNKNOWN_PUBKEY (lifetime — ZERO envelope, 200 not 404)"
ZERO=$(curl -fsS "$INDEXER_URL/api/recipients/$UNKNOWN_PUBKEY")
echo "    $ZERO"
echo "$ZERO" | grep -q '"lifetimeEarnedLamports":"0"' || { echo "!! expected zero envelope"; exit 1; }
echo "$ZERO" | grep -q '"recipientKind":null' || { echo "!! expected recipientKind=null"; exit 1; }
echo "   PASS"

echo ">> [7] GET /api/recipients/$KNOWN_PUBKEY/settlements (first page)"
PAGE1=$(curl -fsS "$INDEXER_URL/api/recipients/$KNOWN_PUBKEY/settlements?limit=10")
echo "    $PAGE1"
echo "$PAGE1" | grep -q "\"txSignature\":\"${SIG_FAKE}\"" || { echo "!! expected txSignature in items[]"; exit 1; }
echo "$PAGE1" | grep -q '"amountLamports":"700"' || { echo "!! expected amountLamports=700"; exit 1; }
echo "$PAGE1" | grep -q '"nextCursor":null' || { echo "!! single row => nextCursor should be null"; exit 1; }
echo "   PASS"

echo ">> [8] GET /api/recipients/$UNKNOWN_PUBKEY/settlements (empty envelope, 200)"
EMPTY=$(curl -fsS "$INDEXER_URL/api/recipients/$UNKNOWN_PUBKEY/settlements")
echo "    $EMPTY"
echo "$EMPTY" | grep -q '"items":\[\]' || { echo "!! expected empty items[]"; exit 1; }
echo "$EMPTY" | grep -q '"nextCursor":null' || { echo "!! expected nextCursor:null"; exit 1; }
echo "   PASS"

echo
echo "=== smoke-affiliate ALL PASS ==="
