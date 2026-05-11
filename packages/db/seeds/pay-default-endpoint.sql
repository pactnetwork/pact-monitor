-- Endpoint registry seed: `pay-default` — the shared launch coverage pool for
-- pay.sh / x402-covered calls (the `facilitator.pact.network` service).
--
-- This is a SYNTHETIC endpoint: there is no real upstream behind it. `pact pay`
-- settles the x402/MPP payment DIRECTLY with the merchant; after that, the
-- facilitator registers the payment receipt + verdict side-band and publishes a
-- SettlementEvent onto the shared Pub/Sub topic with source: "pay.sh" and
-- endpointSlug: "pay-default". The on-chain EndpointConfig for this slug exists
-- purely so a CoveragePool (the refund reservoir) can hang off it — see
-- `register_endpoint` co-creating the pool atomically. So `upstreamBase` here
-- is a never-fetched sentinel; it just has to be a non-empty URL because the
-- column is non-nullable and the market-proxy's `new URL(...)` would throw on
-- "". (`pay-default` is also in the indexer's DEFAULT_UPSTREAM_BASE map with
-- the same sentinel, so a chain-first lazy-create resolves correctly too.)
--
-- It MUST be created (a) here in Postgres AND (b) on-chain via register_endpoint
-- (scripts/pay-default-bootstrap.ts) — the indexer's OnChainSyncService
-- overwrites the on-chain-derived columns (flatPremiumLamports, percentBps,
-- slaLatencyMs, imputedCostLamports, exposureCapPerHourLamports, paused) every
-- 5 minutes and on boot, but it only sets `upstreamBase`/`displayName` on first
-- CREATE. So: insert this row BEFORE the on-chain endpoint exists (or with
-- matching values) and the sync will keep it in step.
--
-- Amounts are USDC base units (6 decimals): 1_000 = $0.001, 1_000_000 = $1.00.
--
-- Rationale for each value:
--   slug                       'pay-default' — 11 chars, fits VARCHAR(16); matches the on-chain 16-byte slug.
--   flatPremiumLamports        1000          — $0.001/call. Same order as `dummy`/`helius`; small launch value,
--                                              comfortably above MIN_PREMIUM_LAMPORTS (100). `percentBps`=0 means
--                                              this flat amount is the whole premium regardless of payment size.
--   percentBps                 0             — flat-only premium (like every production endpoint). A %-of-payment
--                                              premium is a post-MVP option; the flat fee keeps it predictable.
--   slaLatencyMs               10000         — 10s SLA. pay.sh-covered calls are full HTTP request/responses to
--                                              arbitrary merchants (not RPC pings), so the SLA is generous; the
--                                              CLI's classifier `verdict` (which it sends to the facilitator) is
--                                              the authoritative source of the outcome anyway — this column is
--                                              mostly metadata for the discovery payload.
--   imputedCostLamports        1000000       — PER-CALL REFUND CEILING ($1.00). On a covered breach the facilitator
--                                              refunds the amount the agent actually paid the merchant (verified
--                                              on-chain), CAPPED at this value, so a single large claim can't drain
--                                              the subsidised launch float. $1.00 covers typical small x402 calls
--                                              in full. (NB: unlike the gateway path, where imputed_cost is a fixed
--                                              refund, here it's a ceiling — the on-chain settle_batch uses the
--                                              per-event refund_lamports the facilitator computes, not this column.)
--   exposureCapPerHourLamports 5000000       — $5.00/rolling-hour MAX payout from the pay-default pool, enforced
--                                              on-chain by settle_batch. Deliberately TIGHT — this is a Pact-
--                                              subsidised launch float, not an actuarially-priced product. ~5 full
--                                              $1.00 refunds/hr before the on-chain hourly cap clamps. Bump it (and
--                                              top up the pool) as real volume + a per-target-pool split land.
--   paused                     false         — live.
--   upstreamBase               'https://facilitator.pact.network/pay-default'  — sentinel; never fetched (see above).
--   displayName                'Pact pay.sh launch coverage pool'
--   logoUrl                    NULL
--
-- DO NOT run this against prod without operator sign-off. The companion
-- on-chain bootstrap is scripts/pay-default-bootstrap.ts (which DOES permit
-- mainnet behind an explicit --mainnet flag, since the operator runs it on
-- mainnet — the SQL row should be seeded in the same place the on-chain
-- endpoint is registered).

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
  'pay-default',
  1000,
  0,
  10000,
  1000000,
  5000000,
  false,
  'https://facilitator.pact.network/pay-default',
  'Pact pay.sh launch coverage pool',
  NULL,
  NOW(),
  NOW()
)
ON CONFLICT (slug) DO UPDATE SET
  "upstreamBase" = EXCLUDED."upstreamBase",
  "displayName"  = EXCLUDED."displayName",
  "lastUpdated"  = NOW();
