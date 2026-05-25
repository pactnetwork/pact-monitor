-- seed-local-dummy.sql — insured `dummy` endpoint for the LOCAL soft-mode
-- devnet E2E (scripts/devnet/local-soft-e2e.sh). Values mirror the canonical
-- packages/db/seeds/dummy-endpoint.sql EXCEPT upstreamBase, which points at the
-- locally-run @pact-network/dummy-upstream (PORT=8799) instead of the public
-- https://dummy.pactnetwork.io host. Idempotent.
INSERT INTO "Endpoint" (
  slug,
  "flatPremiumLamports",
  "percentBps",
  "slaLatencyMs",
  "imputedCostLamports",
  "exposureCapPerHourLamports",
  paused,
  "upstreamBase",
  "displayName",
  "logoUrl",
  "registeredAt",
  "lastUpdated"
) VALUES (
  'dummy',
  1000,        -- flatPremiumLamports  ($0.001/call, USDC 6dp)
  0,           -- percentBps           (flat-only; does NOT gate coverage)
  2000,        -- slaLatencyMs         (2s SLA)
  10000,       -- imputedCostLamports  ($0.01 refund on breach)
  1000000,     -- exposureCapPerHourLamports ($1.00/hr)
  false,       -- paused
  'http://localhost:8799',          -- upstreamBase (LOCAL dummy-upstream)
  'Pact Dummy Upstream (demo)',     -- displayName
  NULL,        -- logoUrl
  NOW(),       -- registeredAt
  NOW()        -- lastUpdated
)
ON CONFLICT (slug) DO UPDATE SET
  "upstreamBase" = EXCLUDED."upstreamBase",
  "displayName"  = EXCLUDED."displayName",
  paused         = EXCLUDED.paused,
  "lastUpdated"  = NOW();
