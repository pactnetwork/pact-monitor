import type { Pool } from "pg";

export class Allowlist {
  private set = new Set<string>();
  private loadedAt = 0;
  private readonly TTL_MS = 60_000;

  constructor(
    private readonly pg: Pick<Pool, "query">,
    private readonly table: "demo_allowlist" | "operator_allowlist"
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
      `SELECT pubkey FROM ${this.table}`
    );
    this.set.clear();
    for (const r of rows) {
      this.set.add(r.pubkey);
    }
    this.loadedAt = Date.now();
  }
}
