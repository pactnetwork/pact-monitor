/**
 * pay-default-endpoint.ts — idempotently seed the `pay-default` Endpoint row,
 * the shared launch coverage pool for pay.sh / x402-covered calls (the
 * `facilitator.pact.network` service).
 *
 * `pay-default` is a SYNTHETIC endpoint — no real upstream. `pact pay` settles
 * the x402/MPP payment directly with the merchant; the facilitator registers
 * the receipt side-band and publishes a SettlementEvent onto the shared Pub/Sub
 * topic with source: "pay.sh", endpointSlug: "pay-default". The on-chain
 * EndpointConfig exists only so a CoveragePool (the refund reservoir) can hang
 * off it. `upstreamBase` is therefore a never-fetched sentinel; it just has to
 * be a non-empty URL (the column is non-nullable and the market-proxy's
 * `new URL(...)` throws on "").
 *
 * The on-chain-derived business fields (flatPremiumLamports / percentBps /
 * slaLatencyMs / imputedCostLamports / exposureCapPerHourLamports / paused) are
 * overwritten by the indexer's OnChainSyncService every 5 minutes once the
 * matching on-chain EndpointConfig PDA exists; until then this seed's values
 * stand in. Run this AFTER / alongside the on-chain `register_endpoint` for
 * slug `pay-default` (see scripts/pay-default-bootstrap.ts and
 * docs/premium-coverage-mvp.md Part B).
 *
 * Usage (DO NOT run against prod without sign-off — but, unlike the dummy
 * seed, prod IS the eventual home for this row; gate with ALLOW_PROD_SEED=1):
 *
 *   PG_URL=postgresql://user:pass@host:5432/pact \
 *     pnpm --filter @pact-network/db exec tsx seeds/pay-default-endpoint.ts
 *
 *   # then reload the market-proxy registry so /.well-known/endpoints picks it up:
 *   curl -X POST https://<market-proxy-host>/admin/reload-endpoints \
 *     -H "Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN"
 *
 * Values mirror seeds/pay-default-endpoint.sql AND scripts/pay-default-bootstrap.ts
 * — keep the three in sync. See the .sql file for the rationale on each value.
 */
import { PrismaClient } from "@prisma/client";

// USDC base units (6 decimals). 1_000 = $0.001, 1_000_000 = $1.00.
const PAY_DEFAULT_ENDPOINT = {
  slug: "pay-default",
  flatPremiumLamports: 1_000n, // $0.001/call — small launch value, > MIN_PREMIUM_LAMPORTS (100)
  percentBps: 0, // flat-only premium (like every production endpoint)
  slaLatencyMs: 10_000, // 10s SLA — pay.sh calls are full HTTP round-trips; the CLI's verdict is authoritative anyway
  imputedCostLamports: 1_000_000n, // PER-CALL REFUND CEILING ($1.00) — refund = amount paid, capped at this
  exposureCapPerHourLamports: 5_000_000n, // $5.00/rolling-hour pool payout cap — tight subsidised-launch float
  paused: false,
  upstreamBase: "https://facilitator.pact.network/pay-default", // sentinel; never fetched
  displayName: "Pact pay.sh launch coverage pool",
  logoUrl: null as string | null,
};

async function main(): Promise<void> {
  const pgUrl = process.env.PG_URL;
  if (!pgUrl) {
    throw new Error("PG_URL is required");
  }
  if (/prod|mainnet/i.test(pgUrl) && process.env.ALLOW_PROD_SEED !== "1") {
    throw new Error(
      "PG_URL looks like a production database. Refusing to seed without ALLOW_PROD_SEED=1.",
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url: pgUrl } } });
  try {
    const now = new Date();
    const row = await prisma.endpoint.upsert({
      where: { slug: PAY_DEFAULT_ENDPOINT.slug },
      create: { ...PAY_DEFAULT_ENDPOINT, registeredAt: now, lastUpdated: now },
      // On update, only refresh the off-chain-managed fields + lastUpdated —
      // mirrors the indexer's "don't clobber on-chain-derived columns" rule in
      // reverse (this seed owns upstreamBase/displayName; the chain owns the
      // rate fields).
      update: {
        upstreamBase: PAY_DEFAULT_ENDPOINT.upstreamBase,
        displayName: PAY_DEFAULT_ENDPOINT.displayName,
        logoUrl: PAY_DEFAULT_ENDPOINT.logoUrl,
        lastUpdated: now,
      },
    });
    // eslint-disable-next-line no-console
    console.log(
      `seeded Endpoint slug=${row.slug} upstreamBase=${row.upstreamBase} ` +
        `flatPremiumLamports=${row.flatPremiumLamports} slaLatencyMs=${row.slaLatencyMs} ` +
        `imputedCostLamports=${row.imputedCostLamports} exposureCapPerHourLamports=${row.exposureCapPerHourLamports} paused=${row.paused}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
