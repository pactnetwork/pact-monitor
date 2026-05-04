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
// Down migration: collapses 'client_error' and 'server_error' rows back to
// 'error' on both call_records and claims, and re-adds the original CHECK
// constraint sets. Note this is lossy at the type level — once collapsed,
// re-running up will reclassify by status_code which produces the same
// outcome for call_records. claims rows will all return as 'error' and be
// re-mapped to 'server_error' (matches the original up direction).
//
// Runbook
// -------
//   # Apply (up):
//   DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
//     run migrate:split-error-classification
//
//   # Revert (down):
//   DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
//     run migrate:split-error-classification -- --down
//
// Or directly:
//   DATABASE_URL=postgres://... npx tsx \
//     migrations/20260503-split-error-classification.ts [--down]

import pg from "pg";
import { fileURLToPath } from "node:url";

export async function up(client: pg.Client | pg.PoolClient): Promise<void> {
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
}

export async function down(client: pg.Client | pg.PoolClient): Promise<void> {
  // 1. Drop the new CHECK constraints so we can write 'error' rows again.
  await client.query(`
    ALTER TABLE call_records
      DROP CONSTRAINT IF EXISTS call_records_classification_check
  `);
  await client.query(`
    ALTER TABLE claims
      DROP CONSTRAINT IF EXISTS claims_trigger_type_check
  `);

  // 2. Collapse split classifications back to 'error'. status_code is
  //    preserved so re-applying up reproduces the same client_error /
  //    server_error split on call_records. claims rows all become 'error'.
  await client.query(`
    UPDATE call_records
    SET classification = 'error'
    WHERE classification IN ('client_error', 'server_error')
  `);
  await client.query(`
    UPDATE claims
    SET trigger_type = 'error'
    WHERE trigger_type = 'server_error'
  `);

  // 3. Re-add the original CHECK constraints (pre-PR #47 schema.sql).
  await client.query(`
    ALTER TABLE call_records
      ADD CONSTRAINT call_records_classification_check
      CHECK (classification IN ('success', 'timeout', 'error', 'schema_mismatch'))
  `);
  await client.query(`
    ALTER TABLE claims
      ADD CONSTRAINT claims_trigger_type_check
      CHECK (trigger_type IN ('timeout', 'error', 'schema_mismatch', 'latency_sla'))
  `);
}

async function runCli(): Promise<void> {
  const isDown = process.argv.includes("--down");
  const connectionString =
    process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (isDown) {
      await down(client);
    } else {
      await up(client);
    }
    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log(
      `split-error-classification migration: ${isDown ? "DOWN" : "UP"} OK`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

// Run only when invoked as a CLI (tsx … 20260503-…ts). Importing this
// module from a test must not trigger run + process.exit.
const isMain = import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
