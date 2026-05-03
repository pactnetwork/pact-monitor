// Phase 3 (this PR): split call_records.classification 'error' into
// 'client_error' (4xx — agent's fault, not claimable) and 'server_error'
// (5xx + network errors — provider's fault, claimable).
//
// Also updates claims.trigger_type CHECK constraint: drops 'error', adds
// 'server_error'. We don't add 'client_error' to claims.trigger_type because
// 4xx never produces a claim row (REFUND_PCT['client_error'] is undefined,
// so maybeCreateClaim returns null before any insert).
//
// Backfill strategy for existing rows:
//   call_records.status_code is preserved on every row, so we can reclassify
//   deterministically:
//     'error' AND status_code BETWEEN 400 AND 499  -> 'client_error'
//     'error' AND status_code >= 500               -> 'server_error'
//     'error' AND status_code = 0                  -> 'server_error' (network)
//     'error' AND anything else                    -> 'server_error' (conservative)
//   claims.trigger_type='error' -> 'server_error' for every existing row.
//   We don't reclassify claims to client_error because they were already
//   filed as 100%-refund claims under the old behavior — surfacing them as
//   client_error after-the-fact would imply a refund occurred for a 4xx,
//   which is exactly what we're saying is wrong. Better to keep them as
//   server_error so historical refund accounting still ties out.
//
// Idempotent — re-running is a no-op (ALTER TABLE … DROP CONSTRAINT IF EXISTS,
// UPDATE rows whose classification is already in the new set is a no-op).
//
// Runbook
// -------
//   DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
//     run migrate:split-error-classification
// Or directly:
//   DATABASE_URL=postgres://... npx tsx \
//     migrations/20260503-split-error-classification.ts

import pg from "pg";

async function run(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");

    // 1. Drop old CHECK constraints. Postgres assigns predictable names but
    //    pg_get_constraintdef would be safer. Both schemas hardcode the names
    //    via inline CHECK so we use the auto-generated _check suffix.
    await client.query(`
      ALTER TABLE call_records
        DROP CONSTRAINT IF EXISTS call_records_classification_check
    `);
    await client.query(`
      ALTER TABLE claims
        DROP CONSTRAINT IF EXISTS claims_trigger_type_check
    `);

    // 2. Backfill call_records.classification using preserved status_code.
    await client.query(`
      UPDATE call_records
      SET classification = 'client_error'
      WHERE classification = 'error'
        AND status_code BETWEEN 400 AND 499
    `);
    await client.query(`
      UPDATE call_records
      SET classification = 'server_error'
      WHERE classification = 'error'
    `);

    // 3. Backfill claims.trigger_type. Existing 'error' rows were all already
    //    filed as 100%-refund — preserve refund accounting by mapping to
    //    'server_error'.
    await client.query(`
      UPDATE claims
      SET trigger_type = 'server_error'
      WHERE trigger_type = 'error'
    `);

    // 4. Re-add CHECK constraints with the new allowed sets.
    await client.query(`
      ALTER TABLE call_records
        ADD CONSTRAINT call_records_classification_check
        CHECK (classification IN ('success', 'timeout', 'client_error', 'server_error', 'schema_mismatch'))
    `);
    await client.query(`
      ALTER TABLE claims
        ADD CONSTRAINT claims_trigger_type_check
        CHECK (trigger_type IN ('timeout', 'server_error', 'schema_mismatch', 'latency_sla'))
    `);

    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log("split-error-classification migration: OK");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
