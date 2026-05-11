#!/usr/bin/env bash
# Pact coverage demo driver — probes the live flaky upstream + prints the
# `pact pay` / `pact <url>` commands for the full demo. See the `pact-demo`
# Claude Code skill (packages/cli/skills/pact-demo/SKILL.md) for the narration.
#
# Usage: bash packages/dummy-upstream/demo.sh
set -euo pipefail

BASE="${DUMMY_BASE:-https://dummy.pactnetwork.io}"
hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
run() { printf '\033[2m$ %s\033[0m\n' "$*"; eval "$@"; printf '\n'; }

hr "1. the dummy is up"
run "curl -s $BASE/health"

hr "2. toggles (no pact/pay needed — these prove the failure cases exist)"
run "curl -si $BASE/quote/AAPL                       | head -1"
run "curl -si '$BASE/quote/AAPL?fail=1'              | head -1   # 503 — 'upstream down'"
run "curl -si '$BASE/quote/AAPL?status=502'          | head -1   # arbitrary status"
run "curl -s  '$BASE/quote/AAPL?latency=1500' -o /dev/null -w '  (latency=1500 → %{time_total}s)\n'"
run "curl -si '$BASE/quote/AAPL?x402=1'              | head -1   # 402 — x402 paywall"
run "curl -si -H 'X-Payment: demo' '$BASE/quote/AAPL?x402=1'             | head -1   # 200 — paid"
run "curl -si -H 'Payment-Signature: demo' '$BASE/quote/AAPL?x402=1&fail=1' | head -1   # 503 — paid, then upstream down"

hr "3. the pact pay demo (run these yourself — needs: npm i -g @q3labs/pact-cli, the 'pay' binary, 'pay setup')"
cat <<EOF
  # happy path — pact pay wraps pay.sh; Pact records a 'success' coverage verdict:
  pact pay curl --sandbox '$BASE/quote/AAPL?x402=1'

  # the case Pact exists for — agent paid, then the upstream 5xx'd → 'server_error', refund-eligible:
  pact pay curl --sandbox '$BASE/quote/AAPL?x402=1&fail=1'

  # (--sandbox = localnet, fake USDC. NOTE: the dummy's x402 payTo is a placeholder —
  #  if 'pay --sandbox' errors on the recipient, ask the maintainer to set a real payTo.
  #  Do NOT run mainnet 'pact pay' against the dummy until that's fixed.)
EOF

hr "4. the gateway path (on-chain refund) — once 'dummy' is onboarded as a Pact endpoint:"
cat <<EOF
  export PACT_MAINNET_ENABLED=1
  pact approve 1.0
  pact --json $BASE/quote/AAPL?fail=1     # server_error → premium debited, refund settling on-chain
  pact calls <id>                          # → the settle_batch tx → https://solscan.io/tx/<sig>

  # until then it returns no_provider — use Demo A above, or 'pact <url>' against an onboarded provider
  # (api.helius.xyz, public-api.birdeye.so, quote-api.jup.ag, lite-api.jup.ag, api.elfa.ai, fal.run).
EOF
echo
