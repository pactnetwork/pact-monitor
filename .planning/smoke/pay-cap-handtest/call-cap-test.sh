#!/usr/bin/env bash
# Two LIVE signed calls to POST /v1/coverage/register in UNVERIFIED mode:
#   (a) amountBaseUnits=9999999999  -> expect refund 1001000  (CAPPED at imputed+premium)
#   (b) amountBaseUnits=500000      -> expect refund 501000   (UNCAPPED: amount < imputed)
# Both use a covered-breach verdict (server_error) so a refund flows.
# Saves all artifacts under artifacts/. Then pulls the published Pub/Sub events.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
source "$HERE/harness.env"
ART="$HERE/artifacts"
mkdir -p "$ART"

# Pick the agent wallet: the first candidate whose devnet USDC ATA has a
# balance + delegated allowance >= premium (so the live allowance check passes
# and the refund/cap is observable). Falls back primary -> pact-smoke.
WALLET="$(RPC_URL="$RPC_URL" USDC_MINT="$USDC_MINT" node "$HERE/pick-wallet.mjs" "$WALLET_PRIMARY" "$WALLET_FALLBACK" 2>"$ART/wallet-pick.out")"
cat "$ART/wallet-pick.out"
if [ -z "$WALLET" ]; then echo "FATAL: no provisioned agent wallet found"; exit 1; fi
echo "== agent wallet: $WALLET =="

echo "== call (a): amountBaseUnits=9999999999 (expect CAPPED refund=1001000) =="
node "$HERE/sign-register.mjs" --wallet "$WALLET" --amount 9999999999 --asset "$USDC_MINT" \
  --url "$FACILITATOR_URL" --resource "https://pay.local/handtest-capped" \
  --reqout "$ART/capped.request.json" --resout "$ART/capped.json" || true

echo "== call (b): amountBaseUnits=500000 (expect UNCAPPED refund=501000) =="
node "$HERE/sign-register.mjs" --wallet "$WALLET" --amount 500000 --asset "$USDC_MINT" \
  --url "$FACILITATOR_URL" --resource "https://pay.local/handtest-uncapped" \
  --reqout "$ART/uncapped.request.json" --resout "$ART/uncapped.json" || true

echo "== pull published Pub/Sub SettlementEvents (evidence) =="
( cd "$REPO/packages/facilitator" && \
  PUBSUB_PROJECT="$PUBSUB_PROJECT" PUBSUB_SUB="$PUBSUB_SUB" PUBSUB_EMULATOR_HOST="$PUBSUB_EMULATOR_HOST" \
  node "$HERE/pull-events.mjs" --out "$ART/pubsub-events.json" --waitMs 6000 ) | tee "$ART/pubsub-pull.out"

echo "== facilitator.log tail =="
tail -20 "$HERE/facilitator.log" | tee "$ART/facilitator.log.excerpt"
echo "DONE. Artifacts in $ART"
