// Merchant SDK Commit 1: merchant role + observation provenance migration.
//
// Mirrors the additive block appended to packages/backend/src/schema.sql so
// this script can be re-run safely against any environment whose schema.sql
// has not yet been re-applied.
//
// Adds:
//   api_keys.role                  TEXT NOT NULL DEFAULT 'agent'
//                                  CHECK ('agent','merchant','partner')
//   idx_api_keys_role
//   call_records.origin            TEXT NOT NULL DEFAULT 'agent'
//                                  CHECK ('agent','merchant','proxy')
//   call_records.merchant_pubkey   TEXT NULL
//   idx_call_records_origin
//   idx_call_records_merchant_pubkey
//
// Idempotent — re-running is a no-op.
//
// Runbook
// -------
//   DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
//     run migrate:merchant-role-and-origin
// Or directly:
//   DATABASE_URL=postgres://... npx tsx \
//     migrations/20260601-merchant-role-and-origin.ts

import pg from "pg";

async function run(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";
  const pool = new pg.Pool({ connectionString });

  console.log(
    `Merchant role/origin migration against ${connectionString.replace(/:[^:@]+@/, ":***@")}`,
  );

  const statements: Array<{ label: string; sql: string }> = [
    {
      label: "api_keys.role",
      sql: `ALTER TABLE api_keys
              ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'agent'
                CHECK (role IN ('agent', 'merchant', 'partner'))`,
    },
    {
      label: "idx_api_keys_role",
      sql: "CREATE INDEX IF NOT EXISTS idx_api_keys_role ON api_keys(role)",
    },
    {
      label: "call_records.origin",
      sql: `ALTER TABLE call_records
              ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'agent'
                CHECK (origin IN ('agent', 'merchant', 'proxy'))`,
    },
    {
      label: "call_records.merchant_pubkey",
      sql: "ALTER TABLE call_records ADD COLUMN IF NOT EXISTS merchant_pubkey TEXT NULL",
    },
    {
      label: "idx_call_records_origin",
      sql: "CREATE INDEX IF NOT EXISTS idx_call_records_origin ON call_records(origin, created_at DESC)",
    },
    {
      label: "idx_call_records_merchant_pubkey",
      sql: "CREATE INDEX IF NOT EXISTS idx_call_records_merchant_pubkey ON call_records(merchant_pubkey) WHERE merchant_pubkey IS NOT NULL",
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
    console.log("Merchant role/origin schema applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

run().catch((err) => {
  console.error("Merchant migration failed:", err);
  process.exit(1);
});
