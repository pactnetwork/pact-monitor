/**
 * dummy-endpoint.ts — idempotently seed the `dummy` Endpoint row.
 *
 * The market-proxy reads the `Endpoint` Postgres table to resolve a slug to
 * its upstream base + (off-chain) display metadata. The on-chain-derived
 * business fields (flatPremiumLamports / percentBps / slaLatencyMs /
 * imputedCostLamports / exposureCapPerHourLamports / paused) are overwritten
 * by the indexer's OnChainSyncService every 5 minutes once the matching
 * on-chain EndpointConfig PDA exists; until then this seed's values stand in.
 *
 * Run this AFTER the dummy upstream is deployed and BEFORE / alongside the
 * on-chain `register_endpoint` for slug `dummy` (see
 * scripts/dummy-coverage-pool.ts and docs/premium-coverage-mvp.md).
 *
 * Usage (devnet/staging only — DO NOT run against prod without sign-off):
 *
 *   PG_URL=postgresql://user:pass@host:5432/pact \
 *     pnpm --filter @pact-network/db exec tsx seeds/dummy-endpoint.ts
 *
 *   # then reload the market-proxy registry:
 *   curl -X POST https://<market-proxy-host>/admin/reload-endpoints \
 *     -H "Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN"
 *
 * Values mirror seeds/dummy-endpoint.sql — keep the two in sync.
 */
import { PrismaClient } from "@prisma/client";

// USDC base units (6 decimals). 1_000 = $0.001, 1_000_000 = $1.00.
const DUMMY_ENDPOINT = {
  slug: "dummy",
  flatPremiumLamports: 1_000n, // $0.001/call — small demo value, > MIN_PREMIUM_LAMPORTS (100)
  percentBps: 0, // flat-only premium (like all 5 production endpoints)
  slaLatencyMs: 2_000, // 2s SLA per the interface contract; ?latency=2500 breaches
  imputedCostLamports: 10_000n, // $0.01 refunded on a covered failure (10× premium → visible refund)
  exposureCapPerHourLamports: 1_000_000n, // $1.00/rolling-hour pool payout cap (demo-scale)
  paused: false,
  upstreamBase: "https://dummy.pactnetwork.io",
  displayName: "Pact Dummy Upstream (demo)",
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
      where: { slug: DUMMY_ENDPOINT.slug },
      create: { ...DUMMY_ENDPOINT, registeredAt: now, lastUpdated: now },
      // On update, only refresh the off-chain-managed fields + lastUpdated —
      // mirrors the indexer's "don't clobber on-chain-derived columns" rule
      // in reverse (this seed owns upstreamBase/displayName; the chain owns
      // the rate fields).
      update: {
        upstreamBase: DUMMY_ENDPOINT.upstreamBase,
        displayName: DUMMY_ENDPOINT.displayName,
        logoUrl: DUMMY_ENDPOINT.logoUrl,
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
