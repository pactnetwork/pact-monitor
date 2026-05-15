#!/usr/bin/env bash
#
# scripts/devnet-smoke/health.sh
#
# Post-deploy health probe for the Railway-hosted devnet stack. Verifies
# all 3 public hostnames respond, the indexer has chain-sync'd at least
# one endpoint, and the Redis Streams queue isn't stuck.
#
# This is the SUBSET of the plan §8 smoke that runs without a funded test
# agent or settlement-authority access. For the full 10-call end-to-end
# smoke, see the README in this directory.
#
# Exit codes:
#   0  all checks pass
#   1  at least one check failed (details printed)
#
# Env (all optional, sensible devnet defaults):
#   PROXY_URL            default: https://api-devnet.pactnetwork.io
#   INDEXER_URL          default: https://indexer-devnet.pactnetwork.io
#   DASHBOARD_URL        default: https://app-devnet.pactnetwork.io
#   REDIS_URL            (optional) — if set, runs XLEN + XPENDING sanity
#                        checks via redis-cli. Skipped if redis-cli missing.

set -uo pipefail

PROXY_URL="${PROXY_URL:-https://api-devnet.pactnetwork.io}"
INDEXER_URL="${INDEXER_URL:-https://indexer-devnet.pactnetwork.io}"
DASHBOARD_URL="${DASHBOARD_URL:-https://app-devnet.pactnetwork.io}"
DUMMY_URL="${DUMMY_URL:-https://dummy-devnet.pactnetwork.io}"
REDIS_URL="${REDIS_URL:-}"

PASS=0
FAIL=0

# Cloud Armor on mainnet 403s default curl UAs. Railway has no such
# filter, but use the same UA for consistency with mainnet-smoke + so
# logs can be correlated by user-agent. See memory cloud_armor_ua_filter.md.
UA="pact-monitor-sdk/0.1.0"

print_pass() { printf "  \033[32mPASS\033[0m  %s\n" "$1"; PASS=$((PASS + 1)); }
print_fail() { printf "  \033[31mFAIL\033[0m  %s\n    %s\n" "$1" "$2"; FAIL=$((FAIL + 1)); }

# ----- 1. market-proxy health -----
echo "1. market-proxy ($PROXY_URL/health)"
body=$(curl -sS -A "$UA" --max-time 10 "$PROXY_URL/health")
if [[ "$body" == *'"status":"ok"'* ]]; then
  print_pass "/health returns status=ok"
else
  print_fail "/health did not return status=ok" "$body"
fi

# ----- 2. indexer health -----
echo "2. indexer ($INDEXER_URL/health)"
body=$(curl -sS -A "$UA" --max-time 10 "$INDEXER_URL/health")
if [[ "$body" == *'"status":"ok"'* ]]; then
  print_pass "/health returns status=ok"
else
  print_fail "/health did not return status=ok" "$body"
fi

# ----- 3. indexer stats reachable -----
echo "3. indexer ($INDEXER_URL/api/stats)"
body=$(curl -sS -A "$UA" --max-time 10 "$INDEXER_URL/api/stats")
if [[ "$body" == *'"totalPools"'* || "$body" == *'"total_pools"'* || "$body" == "{"*"}" ]]; then
  print_pass "/api/stats returns JSON"
else
  print_fail "/api/stats did not return expected JSON" "$body"
fi

# ----- 4. dashboard reachable -----
echo "4. market-dashboard ($DASHBOARD_URL/)"
status=$(curl -sS -A "$UA" --max-time 15 -o /dev/null -w "%{http_code}" "$DASHBOARD_URL/")
if [[ "$status" == "200" ]]; then
  print_pass "/ returns 200"
else
  print_fail "/ returned HTTP $status" "expected 200"
fi

# ----- 5. indexer endpoints registered -----
echo "5. indexer ($INDEXER_URL/api/endpoints)"
body=$(curl -sS -A "$UA" --max-time 10 "$INDEXER_URL/api/endpoints")
if [[ "$body" == *"helius"* ]]; then
  print_pass "/api/endpoints includes 'helius'"
else
  print_fail "/api/endpoints does not include 'helius'" "Run on-chain init: bun packages/protocol-v1-client/scripts/init-protocol.ts --cluster devnet"
fi

# ----- 6. dummy-upstream health (x402 server) -----
echo "6. dummy-upstream ($DUMMY_URL/health)"
body=$(curl -sS -A "$UA" --max-time 10 "$DUMMY_URL/health")
if [[ "$body" == *'"status":"ok"'* ]]; then
  print_pass "/health returns status=ok"
else
  print_fail "/health did not return status=ok" "$body"
fi

# ----- 7. dummy-upstream serves x402 challenge -----
echo "7. dummy-upstream x402 ($DUMMY_URL/quote/SOL?x402=1)"
status=$(curl -sS -A "$UA" --max-time 10 -o /dev/null -w "%{http_code}" "$DUMMY_URL/quote/SOL?x402=1")
if [[ "$status" == "402" ]]; then
  print_pass "/quote/SOL?x402=1 returns 402 (payment required)"
else
  print_fail "/quote/SOL?x402=1 returned HTTP $status" "expected 402"
fi

# ----- 8. Redis stream sanity (optional) -----
if [[ -n "$REDIS_URL" ]]; then
  echo "8. Redis stream sanity ($REDIS_URL)"
  if ! command -v redis-cli >/dev/null 2>&1; then
    echo "  SKIP  redis-cli not installed; skipping XLEN/XPENDING checks"
  else
    xlen=$(redis-cli -u "$REDIS_URL" XLEN pact-settle-events 2>&1)
    if [[ "$xlen" =~ ^[0-9]+$ ]]; then
      print_pass "XLEN pact-settle-events = $xlen"
    else
      print_fail "XLEN pact-settle-events failed" "$xlen"
    fi
    # XPENDING returns: total, smallest-id, largest-id, [consumers]
    pending=$(redis-cli -u "$REDIS_URL" XPENDING pact-settle-events settler 2>&1 | head -1)
    if [[ "$pending" =~ ^[0-9]+$ ]]; then
      if [[ "$pending" -gt 100 ]]; then
        print_fail "XPENDING settler = $pending (high pending count — settler may be stuck)" "Check settler logs in Railway"
      else
        print_pass "XPENDING settler = $pending"
      fi
    else
      print_fail "XPENDING pact-settle-events settler failed" "$pending"
    fi
  fi
else
  echo "8. Redis stream sanity"
  echo "  SKIP  REDIS_URL not set; export it to run XLEN/XPENDING checks"
fi

echo
echo "----------------------------------------------------------"
echo "  $PASS pass, $FAIL fail"
echo "----------------------------------------------------------"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
