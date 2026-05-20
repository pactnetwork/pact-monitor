#!/usr/bin/env bash
# local-strict-e2e.sh — run the SDK live devnet E2E in STRICT MODE entirely
# locally, wired to the LIVE devnet Pact program. Proves the FULL settlement
# loop AND a REAL on-chain USDC refund:
#
#   dummy-upstream -> market-proxy -> Redis Streams -> settler (real
#   settle_batch on live devnet) -> indexer -> SDK `refund` event
#
# and then an INDEPENDENT on-chain assertion (decode the CallRecord PDA:
# settlement_status==Settled && actual_refund_lamports>0, plus agent USDC ATA
# delta). The SDK assertion ALONE is a false-pass surface: the settler pushes
# the *intended* refund to the indexer, not the on-chain actual — an empty
# pool settles "successfully" with 0 USDC moved yet the indexer still says
# refund>0. Step [10] is the real F2 proof. PASS requires BOTH.
#
# What YOU must supply (the irreducible external surface):
#   1. $DEVNET_KEYS_DIR (default ~/pact-devnet-keys) with THREE identity keys:
#        - pact-network-v1-program-keypair.json  (pubkey == 5jBQb7fL…)
#        - pact-devnet-upgrade-authority.json     (the 47Fg5J… devnet key)
#        - settlement-authority.json              (the SAME 47Fg5J… key)
#      (throwaway vault keypairs are auto-generated if missing.)
#   2. Devnet SOL on the 47Fg5J… authority (init txs + settle_batch fees) —
#      faucet is rate-limited, so fund it out-of-band if the script asks.
#   3. TWO `spl-token mint`s (devnet USDC 4zMMC9… mint authority GrNg1XM2…):
#        - into the `dummy` pool vault (refunds are paid from it) — Step [4]
#        - into the agent ATA (premium source) — Step [6], fund-agent prompts.
#
# Usage:
#   scripts/devnet/local-strict-e2e.sh up     # bring up, provision, run, prove
#   scripts/devnet/local-strict-e2e.sh down    # tear everything down
#
# Optional env:
#   PACT_E2E_DEVNET_RPC   devnet RPC (default https://api.devnet.solana.com;
#                         set a Helius devnet URL to keep settle confirm <15s)
#   DEVNET_KEYS_DIR       default ~/pact-devnet-keys
#   PACT_E2E_KEYFILE      agent keyfile (default /tmp/pact-strict-e2e-agent.json)
#
# Prereqs: pnpm install (once), Docker running, Node 22.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_URL='postgresql://postgres:postgres@localhost:55432/pact_e2e'
PROGRAM_ID='5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5'
USDC_MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
AUTHORITY_PUBKEY='47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS'
RPC="${PACT_E2E_DEVNET_RPC:-https://api.devnet.solana.com}"
KEYS_DIR="${DEVNET_KEYS_DIR:-$HOME/pact-devnet-keys}"
DUMMY_PORT=8799
PROXY_PORT=8798
INDEXER_PORT=3001
SETTLER_PORT=8080
REDIS_STREAM='pact-settle-events'
MIN_POOL_LAMPORTS=1000000   # 1 USDC seed into the dummy pool vault (>= 10000 refund)
KEYFILE="${PACT_E2E_KEYFILE:-/tmp/pact-strict-e2e-agent.json}"
PUSH_SECRET=""
PIDS=()

SCMD() { pnpm --filter @pact-network/scripts-devnet exec tsx verify-network.ts "$@"; }

# Kill whatever holds our fixed ports. dev servers run as `node --require …`
# (tsx) / nest child procs whose argv does NOT match a `tsx watch` pkill — so
# a stale one from a PRIOR session survives pkill and silently answers our
# healthchecks (wrong proxy → no Redis publish → starved settler). Port-based
# kill is the only reliable cleanup.
free_ports() {
  local h
  for p in "$PROXY_PORT" "$DUMMY_PORT" "$INDEXER_PORT" "$SETTLER_PORT"; do
    h="$(lsof -ti tcp:"$p" 2>/dev/null || true)"
    if [[ -n "$h" ]]; then
      echo "   freeing port $p (kill $h)"
      kill -9 $h 2>/dev/null || true
    fi
  done
}
down() {
  echo ">> teardown"
  for pp in "${PIDS[@]:-}"; do kill "$pp" 2>/dev/null || true; done
  free_ports
  docker rm -f pact-e2e-pg pact-e2e-redis 2>/dev/null || true
  echo ">> done (keyfile $KEYFILE + $KEYS_DIR left in place)"
}
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; free_ports' EXIT

if [[ "${1:-up}" == "down" ]]; then down; exit 0; fi
cd "$REPO"

# Pre-flight: a stale dev server from a prior session holding a fixed port
# makes healthchecks pass against the WRONG process (silent miswire — exactly
# what starved the settler once). Free them before anything starts.
echo ">> pre-flight: freeing fixed ports 8798/8799/3001/8080"
free_ports

# --- [0] identity keys present + on-chain authority gate (before ANY write) ---
echo ">> [0] keys + authority gate"
for f in pact-network-v1-program-keypair.json pact-devnet-upgrade-authority.json settlement-authority.json; do
  if [[ ! -f "$KEYS_DIR/$f" ]]; then
    echo "!! missing $KEYS_DIR/$f"
    echo "   Place the 3 identity keys in $KEYS_DIR (see header). The 47Fg5J… key"
    echo "   goes in BOTH pact-devnet-upgrade-authority.json and settlement-authority.json."
    exit 1
  fi
done
# Auto-generate the throwaway vault keypairs (fresh accounts, NOT authorities).
for v in treasury-vault pool-vault-helius pool-vault-dummy; do
  if [[ ! -f "$KEYS_DIR/$v.json" ]]; then
    (cd "$REPO/scripts/devnet" && node --input-type=module -e \
      "import {Keypair} from '@solana/web3.js';import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1],JSON.stringify(Array.from(Keypair.generate().secretKey)))" \
      "$KEYS_DIR/$v.json")
    echo "   generated fresh $KEYS_DIR/$v.json"
  fi
done
# B1 + authority match: the supplied 47Fg5J… key MUST equal on-chain
# ProtocolConfig.authority AND SettlementAuthority.signer, else init-devnet
# register_endpoint and the settler settle_batch would both be rejected.
SCMD probe --program-id "$PROGRAM_ID" --rpc "$RPC" \
  --expect-authority "$AUTHORITY_PUBKEY" --json >/tmp/pact-strict-probe0.json || {
  echo "!! authority gate FAILED — see /tmp/pact-strict-probe0.json"
  SCMD probe --program-id "$PROGRAM_ID" --rpc "$RPC" --expect-authority "$AUTHORITY_PUBKEY" || true
  exit 1
}
echo "   authority gate PASS (47Fg5J… == on-chain ProtocolConfig.authority == SettlementAuthority.signer)"

# --- [1] Postgres + schema + seed dummy ---
echo ">> [1] Postgres :55432 + migrate + seed dummy"
docker rm -f pact-e2e-pg >/dev/null 2>&1 || true
docker run --name pact-e2e-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pact_e2e \
  -p 55432:5432 -d postgres:16 >/dev/null
for i in $(seq 1 60); do
  docker exec pact-e2e-pg pg_isready -U postgres -d pact_e2e >/dev/null 2>&1 && break
  sleep 1
done
PG_URL="$PG_URL" pnpm --filter @pact-network/db run db:migrate >/dev/null
docker exec -i pact-e2e-pg psql -U postgres -d pact_e2e \
  < "$REPO/scripts/devnet/seed-local-dummy.sql" >/dev/null
echo "   dummy seeded (upstreamBase=http://localhost:$DUMMY_PORT)"

# --- [2] dummy-upstream + Redis ---
echo ">> [2] dummy-upstream :$DUMMY_PORT + Redis :6379"
PORT=$DUMMY_PORT pnpm --filter @pact-network/dummy-upstream run dev \
  >/tmp/pact-strict-dummy.log 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do
  [[ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://localhost:$DUMMY_PORT/quote/AAPL?fail=1")" == "503" ]] && break
  sleep 1
done
docker rm -f pact-e2e-redis >/dev/null 2>&1 || true
docker run --name pact-e2e-redis -p 6379:6379 -d redis:7 >/dev/null
for i in $(seq 1 30); do
  docker exec pact-e2e-redis redis-cli ping 2>/dev/null | grep -q PONG && break
  sleep 1
done

# --- [3] on-chain provision: init-devnet (DRY_RUN rehearsal, then real) ---
echo ">> [3] init-devnet (registers helius + dummy on live devnet; idempotent)"
DEVNET_KEYS_DIR="$KEYS_DIR" DEVNET_RPC_URL="$RPC" DRY_RUN=1 \
  pnpm --filter @pact-network/scripts-devnet exec tsx init-devnet.ts 2>&1 | tail -8
echo "   DRY_RUN ok — sending real txs (needs SOL on $AUTHORITY_PUBKEY)…"
if ! DEVNET_KEYS_DIR="$KEYS_DIR" DEVNET_RPC_URL="$RPC" \
  pnpm --filter @pact-network/scripts-devnet exec tsx init-devnet.ts 2>&1 | tail -20; then
  echo "!! init-devnet failed — most likely $AUTHORITY_PUBKEY needs devnet SOL."
  echo "   Fund it (>=0.2 SOL) out-of-band, then re-run: $0 up"
  exit 1
fi

# --- [4] fund the dummy pool vault (MANDATORY user mint — refund source) ---
echo ">> [4] fund the dummy CoveragePool vault (>= $MIN_POOL_LAMPORTS)"
POOLVAULT="$(node -e "const s=require('$REPO/scripts/devnet/.devnet-state.json');const e=(s.endpoints||[]).find(x=>x.slug==='dummy');process.stdout.write(e?e.poolVault:'')" 2>/dev/null || true)"
echo "   dummy pool vault = ${POOLVAULT:-<unknown — see .devnet-state.json>}"
echo "   USER ACTION (devnet USDC mint authority GrNg1XM2…):"
echo "     spl-token mint $USDC_MINT 1 --recipient ${POOLVAULT:-<dummy poolVault>} --url devnet"
echo "   waiting for the pool vault to hold >= $MIN_POOL_LAMPORTS (Ctrl-C to abort)…"
for i in $(seq 1 120); do
  if SCMD probe --program-id "$PROGRAM_ID" --rpc "$RPC" \
       --require-provisioned dummy --min-pool-lamports "$MIN_POOL_LAMPORTS" >/dev/null 2>&1; then
    echo "   pool vault funded — gate PASS"; break
  fi
  [[ $i -eq 120 ]] && { echo "!! pool vault still underfunded after ~10min"; exit 1; }
  sleep 5
done

# --- [5] market-proxy :8798 (strict: redis-streams, NO beta gate) ---
echo ">> [5] market-proxy :$PROXY_PORT (QUEUE_BACKEND=redis-streams)"
PG_URL="$PG_URL" RPC_URL="$RPC" PROGRAM_ID="$PROGRAM_ID" USDC_MINT="$USDC_MINT" \
  QUEUE_BACKEND=redis-streams REDIS_URL='redis://localhost:6379' REDIS_STREAM="$REDIS_STREAM" \
  ENDPOINTS_RELOAD_TOKEN='pact-local-reload-token' PORT=$PROXY_PORT \
  pnpm --filter @pact-network/market-proxy run dev >/tmp/pact-strict-proxy.log 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do
  [[ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://localhost:$PROXY_PORT/health")" == "200" ]] && break
  sleep 1
done
curl -s "http://localhost:$PROXY_PORT/.well-known/endpoints" | grep -q '"slug":"dummy"' \
  || { echo "!! dummy not in proxy discovery"; exit 1; }

# --- [6] provision agent (reuse fund-agent.ts; user mints USDC to agent ATA) ---
echo ">> [6] agent keypair + fund-agent (user mints 5 USDC to agent ATA)"
if [[ ! -f "$KEYFILE" ]]; then
  (cd "$REPO/scripts/devnet" && node --input-type=module -e \
    "import {Keypair} from '@solana/web3.js';import bs58 from 'bs58';const k=Keypair.generate();process.stdout.write(JSON.stringify({pub:k.publicKey.toBase58(),sk:bs58.encode(k.secretKey)}))") \
    > "$KEYFILE"
  chmod 600 "$KEYFILE"
fi
AGENT_SK="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$KEYFILE','utf8')).sk)")"
AGENT_PUB="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$KEYFILE','utf8')).pub)")"
echo "   agent = $AGENT_PUB"
PACT_DEVNET_SECRET_KEY="$AGENT_SK" SOLANA_RPC_URL="$RPC" \
  pnpm --filter @pact-network/scripts-devnet run fund-agent || {
  echo "!! fund-agent did not complete (SOL faucet and/or USDC mint pending)."
  echo "   Fund agent $AGENT_PUB with SOL + 5 USDC, then re-run: $0 up"
  exit 1
}

# --- [7] indexer :3001 (AFTER seed so its boot sync can't clobber upstream) ---
echo ">> [7] indexer :$INDEXER_PORT"
PUSH_SECRET="$(openssl rand -hex 16)"   # 32 hex chars; shared proxy<-settler->indexer
PG_URL="$PG_URL" SOLANA_RPC_URL="$RPC" PROGRAM_ID="$PROGRAM_ID" \
  INDEXER_PUSH_SECRET="$PUSH_SECRET" PORT=$INDEXER_PORT \
  pnpm --filter @pact-network/indexer run start >/tmp/pact-strict-indexer.log 2>&1 & PIDS+=($!)
for i in $(seq 1 60); do
  [[ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://localhost:$INDEXER_PORT/health")" == "200" ]] && break
  [[ $i -eq 60 ]] && { echo "!! indexer did not become healthy"; tail -20 /tmp/pact-strict-indexer.log; exit 1; }
  sleep 1
done

# --- [8] settler + READINESS GATE (consumer group before any covered call) ---
echo ">> [8] settler (redis-streams) + consumer-group readiness gate"
SETTLER_SK_B58="$(cd "$REPO/scripts/devnet" && node --input-type=module -e \
  "import bs58 from 'bs58';import {readFileSync} from 'node:fs';const a=JSON.parse(readFileSync(process.argv[1],'utf8'));process.stdout.write(bs58.encode(Uint8Array.from(a)))" \
  "$KEYS_DIR/settlement-authority.json")"
QUEUE_BACKEND=redis-streams REDIS_URL='redis://localhost:6379' REDIS_STREAM="$REDIS_STREAM" \
  REDIS_CONSUMER_GROUP=settler SOLANA_RPC_URL="$RPC" PROGRAM_ID="$PROGRAM_ID" USDC_MINT="$USDC_MINT" \
  SETTLEMENT_AUTHORITY_KEY="$SETTLER_SK_B58" INDEXER_URL="http://localhost:$INDEXER_PORT" \
  INDEXER_PUSH_SECRET="$PUSH_SECRET" PORT=$SETTLER_PORT \
  pnpm --filter @pact-network/settler run dev >/tmp/pact-strict-settler.log 2>&1 & PIDS+=($!)
# XGROUP CREATE uses "$" — any event XADD'd before the `settler` group exists
# is LOST. Block until the group exists, THEN run the SDK call. (Critical-2.)
for i in $(seq 1 90); do
  if docker exec pact-e2e-redis redis-cli XINFO GROUPS "$REDIS_STREAM" 2>/dev/null | grep -q 'settler'; then
    echo "   settler consumer group ready"; break
  fi
  [[ $i -eq 90 ]] && { echo "!! settler consumer group never appeared"; tail -30 /tmp/pact-strict-settler.log; exit 1; }
  sleep 1
done

# --- [9] capture agent ATA pre-balance, run SDK strict E2E ---
echo ">> [9] SDK strict E2E"
ATA_PRE="$(SCMD ata-balance --program-id "$PROGRAM_ID" --rpc "$RPC" --agent "$AGENT_PUB")"
echo "   agent ATA pre = $ATA_PRE lamports"
set +e
PACT_SDK_E2E=1 PACT_DEVNET_SECRET_KEY="$AGENT_SK" \
  PACT_DEVNET_PROXY_URL="http://localhost:$PROXY_PORT" \
  PACT_DEVNET_PROGRAM_ID="$PROGRAM_ID" \
  PACT_DEVNET_INDEXER_URL="http://localhost:$INDEXER_PORT" \
  pnpm --filter @q3labs/pact-sdk run test:e2e 2>&1 | tee /tmp/pact-strict-sdk.log
SDK_RC=${PIPESTATUS[0]}
set -e
echo "   SDK strict vitest exit = $SDK_RC"

# --- [10] independent on-chain proof (the real F2 deliverable; Critical-1) ---
echo ">> [10] on-chain CallRecord/ATA assertion"
CALLID="$(curl -s "http://localhost:$INDEXER_PORT/api/agents/$AGENT_PUB/calls?limit=1" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);process.stdout.write(a[0]?.callId??'')}catch{process.stdout.write('')}})")"
if [[ -z "$CALLID" ]]; then
  echo "!! no call row in indexer for $AGENT_PUB — settler did not push (inspect /tmp/pact-strict-settler.log)"
  exit 1
fi
echo "   callId = $CALLID"
SCMD assert-refund --program-id "$PROGRAM_ID" --rpc "$RPC" \
  --call-id "$CALLID" --agent "$AGENT_PUB" --ata-pre "$ATA_PRE" --min-refund 1
ASSERT_RC=$?

echo ""
if [[ "$SDK_RC" -eq 0 && "$ASSERT_RC" -eq 0 ]]; then
  echo ">> STRICT E2E PASS — SDK refund event AND real on-chain refund agree."
else
  echo ">> STRICT E2E FAIL — SDK rc=$SDK_RC, on-chain assert rc=$ASSERT_RC"
  echo "   (green vitest + failed assert = the false-pass Step [10] exists to catch)"
  exit 1
fi
echo "   logs: /tmp/pact-strict-{proxy,settler,indexer,sdk}.log · '$0 down' to teardown."
