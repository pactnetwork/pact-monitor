#!/usr/bin/env bash
# Provision (or re-provision) the Tally webhook that powers the private-beta
# intake. Generates a fresh signing secret, registers the webhook against the
# specified Tally form, and writes the signing secret into the pact-monitor
# GitHub Actions secret store so the backend can verify incoming requests.
#
# Run once per environment. Idempotent in the sense that re-running creates a
# brand-new webhook + secret pair; if you only want to rotate the signing
# secret on an existing webhook, use TALLY_WEBHOOK_ID + the rotate path
# (separate task — not implemented here).
#
# Usage:
#   TALLY_API_KEY=tly_... \
#   TALLY_FORM_ID=9qRXzQ \
#   ./scripts/provision-tally-webhook.sh
#
# Optional overrides:
#   WEBHOOK_URL   Defaults to https://api.pactnetwork.io/api/v1/beta/apply
#   GH_REPO       Defaults to pactnetwork/pact-monitor
#   SECRET_NAME   Defaults to TALLY_WEBHOOK_SECRET
#   GH_ENV        If set, scopes the gh secret to a GitHub Actions environment
#                 (e.g. "production"). Omit for repo-wide secret.
#
# Requires: curl, jq, openssl, gh.

set -euo pipefail

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 is required" >&2
    exit 1
  }
}
require curl
require jq
require openssl
require gh

: "${TALLY_API_KEY:?set TALLY_API_KEY (https://tally.so/me/settings/api-keys)}"
: "${TALLY_FORM_ID:?set TALLY_FORM_ID (the form id from tally.so/forms/<id>/edit)}"

WEBHOOK_URL="${WEBHOOK_URL:-https://api.pactnetwork.io/api/v1/beta/apply}"
GH_REPO="${GH_REPO:-pactnetwork/pact-monitor}"
SECRET_NAME="${SECRET_NAME:-TALLY_WEBHOOK_SECRET}"

# 48 raw bytes -> 64 base64 chars; comfortably above the 32 bytes (43 base64
# chars) Tally signs with HMAC-SHA256 and is what the verifier compares.
SIGNING_SECRET="$(openssl rand -base64 48)"

echo "Provisioning Tally webhook"
echo "  form id:     $TALLY_FORM_ID"
echo "  webhook url: $WEBHOOK_URL"
echo "  gh repo:     $GH_REPO"
echo "  secret name: $SECRET_NAME"

response="$(curl --fail-with-body -sS -X POST https://api.tally.so/webhooks \
  -H "Authorization: Bearer $TALLY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg formId "$TALLY_FORM_ID" \
    --arg url "$WEBHOOK_URL" \
    --arg secret "$SIGNING_SECRET" \
    '{formId: $formId, url: $url, eventTypes: ["FORM_RESPONSE"], signingSecret: $secret}')")"

webhook_id="$(jq -r '.id // empty' <<<"$response")"
if [[ -z "$webhook_id" ]]; then
  echo "error: Tally response missing webhook id" >&2
  echo "$response" >&2
  exit 1
fi
echo "Tally webhook created: id=$webhook_id"

if [[ -n "${GH_ENV:-}" ]]; then
  gh secret set "$SECRET_NAME" --repo "$GH_REPO" --env "$GH_ENV" --body "$SIGNING_SECRET"
  echo "GitHub secret $SECRET_NAME stored in repo $GH_REPO (env: $GH_ENV)"
else
  gh secret set "$SECRET_NAME" --repo "$GH_REPO" --body "$SIGNING_SECRET"
  echo "GitHub secret $SECRET_NAME stored in repo $GH_REPO (repo-wide)"
fi

echo
echo "Done. Backend must redeploy to pick up the new secret. The Tally"
echo "webhook is live and signs each FORM_RESPONSE delivery with HMAC-SHA256"
echo "(base64) in the Tally-Signature header."
