// Merchant SDK Commit 2: merchant_endpoints + v_active_merchants + dispute_tickets.
//
// Mirrors the additive block appended to packages/backend/src/schema.sql so
// this script can be re-run safely against any environment whose schema.sql
// has not yet been re-applied.
//
// Adds:
//   merchant_endpoints           table + updated_at trigger
//   idx_merchant_endpoints_hostname
//   idx_merchant_endpoints_status
//   v_active_merchants           view (used by routes/merchants.ts)
//   dispute_tickets              table
//   idx_dispute_tickets_status
//   idx_dispute_tickets_merchant
//
// Idempotent — re-running is a no-op.
//
// Runbook
// -------
//   DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
//     run migrate:merchant-endpoints-and-disputes
// Or directly:
//   DATABASE_URL=postgres://... npx tsx \
//     migrations/20260602-merchant-endpoints-and-disputes.ts

import pg from "pg";

async function run(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";
  const pool = new pg.Pool({ connectionString });

  console.log(
    `Merchant endpoints/disputes migration against ${connectionString.replace(/:[^:@]+@/, ":***@")}`,
  );

  const statements: Array<{ label: string; sql: string }> = [
    {
      label: "merchant_endpoints",
      sql: `CREATE TABLE IF NOT EXISTS merchant_endpoints (
              id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              merchant_pubkey      TEXT NOT NULL,
              hostname             TEXT NOT NULL,
              endpoint_path        TEXT NOT NULL,
              category             TEXT,
              amount_usd           NUMERIC(12,6) NOT NULL,
              preferred_rate_bps   INTEGER NOT NULL CHECK (preferred_rate_bps BETWEEN 0 AND 10000),
              slug                 TEXT NULL,
              on_chain_tx          TEXT NULL,
              status               TEXT NOT NULL DEFAULT 'pending_review'
                CHECK (status IN ('pending_review', 'active', 'paused', 'rejected')),
              created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              UNIQUE (merchant_pubkey, hostname, endpoint_path)
            )`,
    },
    {
      label: "idx_merchant_endpoints_hostname",
      sql: "CREATE INDEX IF NOT EXISTS idx_merchant_endpoints_hostname ON merchant_endpoints(hostname)",
    },
    {
      label: "idx_merchant_endpoints_status",
      sql: "CREATE INDEX IF NOT EXISTS idx_merchant_endpoints_status ON merchant_endpoints(status)",
    },
    {
      label: "merchant_endpoints_set_updated_at function",
      sql: `CREATE OR REPLACE FUNCTION merchant_endpoints_set_updated_at()
            RETURNS trigger AS $$
            BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
            $$ LANGUAGE plpgsql`,
    },
    {
      label: "trg_merchant_endpoints_updated_at",
      sql: `DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM pg_trigger WHERE tgname = 'trg_merchant_endpoints_updated_at'
              ) THEN
                DROP TRIGGER trg_merchant_endpoints_updated_at ON merchant_endpoints;
              END IF;
              CREATE TRIGGER trg_merchant_endpoints_updated_at
                BEFORE UPDATE ON merchant_endpoints
                FOR EACH ROW EXECUTE FUNCTION merchant_endpoints_set_updated_at();
            END $$`,
    },
    {
      label: "v_active_merchants",
      sql: `CREATE OR REPLACE VIEW v_active_merchants AS
            SELECT
              k.agent_pubkey AS merchant_pubkey,
              k.label,
              ARRAY_AGG(DISTINCT e.hostname) FILTER (WHERE e.hostname IS NOT NULL AND e.status = 'active')
                AS hostnames,
              MAX(e.updated_at) AS updated_at
            FROM api_keys k
            LEFT JOIN merchant_endpoints e ON e.merchant_pubkey = k.agent_pubkey
            WHERE k.role = 'merchant' AND k.status = 'active'
            GROUP BY k.agent_pubkey, k.label`,
    },
    {
      label: "dispute_tickets",
      sql: `CREATE TABLE IF NOT EXISTS dispute_tickets (
              id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              merchant_pubkey   TEXT NOT NULL,
              call_record_id    UUID NOT NULL REFERENCES call_records(id),
              reason            TEXT NOT NULL,
              evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
              status            TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'acknowledged', 'resolved_uphold', 'resolved_reverse', 'rejected')),
              ops_note          TEXT,
              created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              resolved_at       TIMESTAMPTZ
            )`,
    },
    {
      label: "idx_dispute_tickets_status",
      sql: "CREATE INDEX IF NOT EXISTS idx_dispute_tickets_status ON dispute_tickets(status, created_at DESC)",
    },
    {
      label: "idx_dispute_tickets_merchant",
      sql: "CREATE INDEX IF NOT EXISTS idx_dispute_tickets_merchant ON dispute_tickets(merchant_pubkey, created_at DESC)",
    },
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const step of statements) {
      console.log(`  applying ${step.label}`);
      await client.query(step.sql);
    }
    await client.query("COMMIT");
    console.log("Merchant endpoints + disputes schema applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

run().catch((err) => {
  console.error("Merchant endpoints migration failed:", err);
  process.exit(1);
});
