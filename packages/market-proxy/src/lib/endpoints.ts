import type { Pool } from "pg";

export interface EndpointRow {
  slug: string;
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
  paused: boolean;
  upstreamBase: string;
  displayName: string;
}

export class EndpointRegistry {
  private cache = new Map<string, EndpointRow>();
  private loadedAt = 0;
  private readonly TTL_MS = 60_000;

  constructor(private readonly pg: Pick<Pool, "query">) {}

  async get(slug: string): Promise<EndpointRow | undefined> {
    if (Date.now() - this.loadedAt > this.TTL_MS) {
      await this.reload();
    }
    return this.cache.get(slug);
  }

  get size(): number {
    return this.cache.size;
  }

  async reload(): Promise<void> {
    const { rows } = await this.pg.query(
      `SELECT slug, flat_premium_lamports, percent_bps, sla_latency_ms,
              imputed_cost_lamports, exposure_cap_per_hour_lamports,
              paused, upstream_base, display_name FROM endpoints`
    );
    this.cache.clear();
    for (const r of rows) {
      this.cache.set(r.slug, {
        slug: r.slug,
        flatPremiumLamports: BigInt(r.flat_premium_lamports),
        percentBps: Number(r.percent_bps),
        slaLatencyMs: Number(r.sla_latency_ms),
        imputedCostLamports: BigInt(r.imputed_cost_lamports),
        exposureCapPerHourLamports: BigInt(r.exposure_cap_per_hour_lamports),
        paused: Boolean(r.paused),
        upstreamBase: r.upstream_base,
        displayName: r.display_name,
      });
    }
    this.loadedAt = Date.now();
  }
}
