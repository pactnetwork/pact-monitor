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
    // The Prisma schema in @pact-network/db creates table "Endpoint" (PascalCase,
    // quoted) with camelCase columns (also quoted). Postgres requires double
    // quotes for any identifier with uppercase letters. Querying lowercase
    // `FROM endpoints` errors with `relation "endpoints" does not exist` and
    // crashes the request handler with a generic 500.
    const { rows } = await this.pg.query(
      `SELECT slug,
              "flatPremiumLamports",
              "percentBps",
              "slaLatencyMs",
              "imputedCostLamports",
              "exposureCapPerHourLamports",
              paused,
              "upstreamBase",
              "displayName"
       FROM "Endpoint"`
    );
    this.cache.clear();
    for (const r of rows) {
      this.cache.set(r.slug, {
        slug: r.slug,
        flatPremiumLamports: BigInt(r.flatPremiumLamports),
        percentBps: Number(r.percentBps),
        slaLatencyMs: Number(r.slaLatencyMs),
        imputedCostLamports: BigInt(r.imputedCostLamports),
        exposureCapPerHourLamports: BigInt(r.exposureCapPerHourLamports),
        paused: Boolean(r.paused),
        upstreamBase: r.upstreamBase,
        displayName: r.displayName,
      });
    }
    this.loadedAt = Date.now();
  }
}
