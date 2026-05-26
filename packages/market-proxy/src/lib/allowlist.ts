import type { Pool } from "pg";

// Prisma owns these tables with PascalCase identifiers (see
// `packages/db/prisma/schema.prisma` — models `DemoAllowlist` /
// `OperatorAllowlist`). Postgres preserves case only when identifiers are
// double-quoted, so raw SQL must quote both the table name and the
// `walletPubkey` column. The constructor still accepts the snake_case
// label as a stable API; this map keeps the call sites unchanged.
const TABLE_SQL: Record<AllowlistTable, string> = {
  demo_allowlist: '"DemoAllowlist"',
  operator_allowlist: '"OperatorAllowlist"',
};

export type AllowlistTable = "demo_allowlist" | "operator_allowlist";

export class Allowlist {
  private set = new Set<string>();
  private loadedAt = 0;
  private readonly TTL_MS = 60_000;

  constructor(
    private readonly pg: Pick<Pool, "query">,
    private readonly table: AllowlistTable
  ) {}

  async has(pubkey: string): Promise<boolean> {
    if (Date.now() - this.loadedAt > this.TTL_MS) {
      await this.reload();
    }
    return this.set.has(pubkey);
  }

  get size(): number {
    return this.set.size;
  }

  async reload(): Promise<void> {
    const { rows } = await this.pg.query(
      `SELECT "walletPubkey" AS pubkey FROM ${TABLE_SQL[this.table]}`
    );
    this.set.clear();
    for (const r of rows) {
      this.set.add(r.pubkey);
    }
    this.loadedAt = Date.now();
  }
}
