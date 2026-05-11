// Coverage-pool config lookup.
//
// The `pay-default` pool's premium / imputed-refund / SLA / exposure-cap come
// from the `Endpoint` Postgres row (slug = PAY_DEFAULT_SLUG), which the
// indexer's OnChainSyncService keeps in step with the on-chain `EndpointConfig`
// PDA. Until that row exists (i.e. before the bootstrap script runs), we fall
// back to the env-supplied defaults so the service still boots and answers
// `/.well-known/pay-coverage`.

import type { Pool } from "pg";

export interface PoolConfigRow {
  slug: string;
  flatPremiumLamports: bigint;
  imputedCostLamports: bigint;
  slaLatencyMs: number;
  exposureCapPerHourLamports: bigint;
  paused: boolean;
  /** Where the row came from — for the discovery payload + debugging. */
  source: "db" | "env-fallback";
}

export interface PoolConfigDefaults {
  slug: string;
  flatPremiumLamports: bigint;
  imputedCostLamports: bigint;
  slaLatencyMs: number;
  exposureCapPerHourLamports: bigint;
}

/**
 * Read the coverage-pool config for `slug` from Postgres, falling back to the
 * supplied env defaults if the row is missing or the read fails. Never throws.
 */
export async function readPoolConfig(
  pg: Pool,
  slug: string,
  defaults: PoolConfigDefaults,
): Promise<PoolConfigRow> {
  try {
    const res = await pg.query(
      `SELECT slug,
              "flatPremiumLamports",
              "imputedCostLamports",
              "slaLatencyMs",
              "exposureCapPerHourLamports",
              paused
         FROM "Endpoint"
        WHERE slug = $1`,
      [slug],
    );
    if (res.rows.length > 0) {
      const r = res.rows[0];
      return {
        slug: r.slug,
        flatPremiumLamports: BigInt(r.flatPremiumLamports),
        imputedCostLamports: BigInt(r.imputedCostLamports),
        slaLatencyMs: Number(r.slaLatencyMs),
        exposureCapPerHourLamports: BigInt(r.exposureCapPerHourLamports),
        paused: Boolean(r.paused),
        source: "db",
      };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[facilitator] readPoolConfig: DB read failed, using env fallback", err);
  }
  return {
    slug: defaults.slug,
    flatPremiumLamports: defaults.flatPremiumLamports,
    imputedCostLamports: defaults.imputedCostLamports,
    slaLatencyMs: defaults.slaLatencyMs,
    exposureCapPerHourLamports: defaults.exposureCapPerHourLamports,
    paused: false,
    source: "env-fallback",
  };
}
