import type { Pool } from "pg";

export interface EndpointRow {
  slug: string;
  /** Network identifier (e.g. "solana-devnet", "arc-testnet"). Added in
   * WP-MN-03a. Rows created before the migration default to "solana-devnet"
   * at the DB level (see Prisma migration). */
  network: string;
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

  async get(slug: string, network?: string): Promise<EndpointRow | undefined> {
    if (Date.now() - this.loadedAt > this.TTL_MS) {
      await this.reload();
    }
    if (network) {
      return this.cache.get(`${slug}::${network}`);
    }
    let match: EndpointRow | undefined;
    for (const [key, row] of this.cache) {
      if (key.startsWith(`${slug}::`)) {
        if (match) return undefined; // multiple matches — ambiguous
        match = row;
      }
    }
    return match;
  }

  async getNetworksForSlug(slug: string): Promise<string[]> {
    if (Date.now() - this.loadedAt > this.TTL_MS) {
      await this.reload();
    }
    const networks: string[] = [];
    for (const [key, _row] of this.cache) {
      if (key.startsWith(`${slug}::`)) {
        networks.push(key.split("::")[1]);
      }
    }
    return networks;
  }

  async getAll(): Promise<EndpointRow[]> {
    if (Date.now() - this.loadedAt > this.TTL_MS) {
      await this.reload();
    }
    return Array.from(this.cache.values());
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
              network,
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
      const key = `${r.slug}::${r.network ?? "solana-devnet"}`;
      this.cache.set(key, {
        slug: r.slug,
        network: r.network ?? "solana-devnet",
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
