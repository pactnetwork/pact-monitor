-- Endpoint registry seed: `dummy` (Pact Dummy Upstream — demo).
--
-- This row makes the market-proxy resolve slug `dummy` to upstream
-- https://dummy.pactnetwork.io. It MUST be created (a) here in Postgres AND
-- (b) on-chain via register_endpoint (init-mainnet.ts / a devnet equivalent)
-- — the indexer's OnChainSyncService overwrites the on-chain-derived columns
-- (flatPremiumLamports, percentBps, slaLatencyMs, imputedCostLamports,
-- exposureCapPerHourLamports, paused) every 5 minutes and on boot, but it
-- only sets `upstreamBase`/`displayName` on first CREATE. So: insert this row
-- BEFORE the on-chain endpoint exists (or with matching values) and the sync
-- will keep it in step. Adding the slug to packages/indexer's
-- DEFAULT_UPSTREAM_BASE map is the alternative way to seed the upstreamBase
-- so a fresh on-chain-only create resolves correctly.
--
-- After this insert, POST /admin/reload-endpoints on the market-proxy
-- (Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN) picks it up immediately;
-- otherwise the in-process 60s TTL cache refreshes on its own.
--
-- Amounts are USDC base units (6 decimals): 1_000 = $0.001, 1_000_000 = $1.00.
--
-- Rationale for each value:
--   slug                       'dummy'      — fits VARCHAR(16); matches the on-chain 16-byte slug.
--   flatPremiumLamports        1000         — $0.001/call. Same order as `helius`; small demo value,
--                                             comfortably above MIN_PREMIUM_LAMPORTS (100).
--   percentBps                 0            — flat-only premium, like all 5 production endpoints.
--   slaLatencyMs               2000         — 2s SLA per the interface contract; ?latency=2500 breaches.
--   imputedCostLamports        10000        — $0.01 refunded on a covered failure (server_error /
--                                             latency_breach / network_error). 10× the premium so a
--                                             refund is clearly visible in the demo without being absurd
--                                             for a quote endpoint.
--   exposureCapPerHourLamports 1000000      — $1.00/rolling-hour max payout from the dummy pool. Demo-scale:
--                                             ~100 refunds/hr before the on-chain hourly cap clamps.
--   paused                     false        — live.
--   upstreamBase               'https://dummy.pactnetwork.io'  — the demo upstream service (pact-dummy-upstream).
--   displayName                'Pact Dummy Upstream (demo)'
--   logoUrl                    NULL
--
-- DO NOT run this against prod without operator sign-off. Devnet/staging only
-- for the MVP demo.

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
  1000,
  0,
  2000,
  10000,
  1000000,
  false,
  'https://dummy.pactnetwork.io',
  'Pact Dummy Upstream (demo)',
  NULL,
  NOW(),
  NOW()
)
ON CONFLICT (slug) DO UPDATE SET
  "upstreamBase" = EXCLUDED."upstreamBase",
  "displayName"  = EXCLUDED."displayName",
  "lastUpdated"  = NOW();
