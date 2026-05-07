// Integration test for the split-error-classification migration.
// Seeds 'error'-classified call_records (4xx, 5xx, network) on a temporary
// CHECK constraint that allows 'error', runs up(), asserts the split,
// asserts the new CHECK rejects 'error', then runs down() and re-asserts
// the original behavior.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { up, down } from "./20260503-split-error-classification.js";

const CONNECTION =
  process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";

describe("split-error-classification migration", () => {
  const pool = new pg.Pool({ connectionString: CONNECTION });
  const tag = randomUUID().slice(0, 8);
  const provHostname = `split-error-${tag}.example`;
  const agentLabel = `split-agent-${tag}`;
  let providerId = "";

  // Snapshot the current CHECK definitions on call_records.classification +
  // claims.trigger_type so we can restore them at end-of-suite, even if the
  // migration leaves the schema in an unexpected state mid-test.
  let savedClassificationCheck = "";
  let savedTriggerTypeCheck = "";

  async function getCheckDef(table: string, name: string): Promise<string | null> {
    const r = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = $1 AND c.conname = $2`,
      [table, name],
    );
    return r.rows[0]?.def ?? null;
  }

  before(async () => {
    // Capture current constraint definitions for restore.
    savedClassificationCheck =
      (await getCheckDef("call_records", "call_records_classification_check")) ?? "";
    savedTriggerTypeCheck =
      (await getCheckDef("claims", "claims_trigger_type_check")) ?? "";

    // Put the schema into the pre-migration state so we can seed 'error' rows.
    // This mirrors what down() does for CHECK constraints.
    await pool.query(
      "ALTER TABLE call_records DROP CONSTRAINT IF EXISTS call_records_classification_check",
    );
    await pool.query(
      "ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_trigger_type_check",
    );
    await pool.query(`
      ALTER TABLE call_records
        ADD CONSTRAINT call_records_classification_check
        CHECK (classification IN ('success', 'timeout', 'error', 'schema_mismatch'))
    `);
    await pool.query(`
      ALTER TABLE claims
        ADD CONSTRAINT claims_trigger_type_check
        CHECK (trigger_type IN ('timeout', 'error', 'schema_mismatch', 'latency_sla'))
    `);

    // Seed provider + 'error' rows: 4xx, 5xx, network (status_code=0).
    const prov = await pool.query<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
      [provHostname, provHostname],
    );
    providerId = prov.rows[0].id;

    const seed = [
      { endpoint: "/4xx-a", status_code: 404 },
      { endpoint: "/4xx-b", status_code: 422 },
      { endpoint: "/5xx-a", status_code: 500 },
      { endpoint: "/5xx-b", status_code: 503 },
      { endpoint: "/network", status_code: 0 },
    ];
    for (const s of seed) {
      await pool.query(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
           latency_ms, classification, agent_id)
         VALUES ($1, $2, NOW(), $3, 100, 'error', $4)`,
        [providerId, s.endpoint, s.status_code, agentLabel],
      );
    }
  });

  after(async () => {
    await pool.query("DELETE FROM call_records WHERE agent_id = $1", [agentLabel]);
    await pool.query("DELETE FROM providers WHERE id = $1", [providerId]);

    // Restore the original constraints so the suite leaves the DB exactly
    // as it found it. If the suite ran clean, up() already restored them
    // to the post-migration form, but other suites may share this DB.
    await pool.query(
      "ALTER TABLE call_records DROP CONSTRAINT IF EXISTS call_records_classification_check",
    );
    await pool.query(
      "ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_trigger_type_check",
    );
    if (savedClassificationCheck) {
      await pool.query(
        `ALTER TABLE call_records ADD CONSTRAINT call_records_classification_check ${savedClassificationCheck}`,
      );
    }
    if (savedTriggerTypeCheck) {
      await pool.query(
        `ALTER TABLE claims ADD CONSTRAINT claims_trigger_type_check ${savedTriggerTypeCheck}`,
      );
    }
    await pool.end();
  });

  it("up() splits 4xx → client_error, 5xx + network → server_error", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await up(client);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const rows = await pool.query<{ endpoint: string; classification: string }>(
      "SELECT endpoint, classification FROM call_records WHERE agent_id = $1 ORDER BY endpoint",
      [agentLabel],
    );
    const byEndpoint = Object.fromEntries(
      rows.rows.map((r) => [r.endpoint, r.classification]),
    );
    assert.equal(byEndpoint["/4xx-a"], "client_error");
    assert.equal(byEndpoint["/4xx-b"], "client_error");
    assert.equal(byEndpoint["/5xx-a"], "server_error");
    assert.equal(byEndpoint["/5xx-b"], "server_error");
    assert.equal(byEndpoint["/network"], "server_error");
  });

  it("up() leaves a CHECK that rejects legacy 'error'", async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
           latency_ms, classification, agent_id)
         VALUES ($1, '/reject', NOW(), 500, 1, 'error', $2)`,
        [providerId, agentLabel],
      ),
      /classification_check/,
      "post-up CHECK must reject 'error'",
    );
  });

  it("down() collapses split rows back to 'error' and restores the old CHECK", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await down(client);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const rows = await pool.query<{ classification: string }>(
      "SELECT classification FROM call_records WHERE agent_id = $1",
      [agentLabel],
    );
    for (const r of rows.rows) {
      assert.equal(r.classification, "error");
    }

    // Old CHECK accepts 'error' again.
    const insert = await pool.query<{ id: string }>(
      `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
         latency_ms, classification, agent_id)
       VALUES ($1, '/accept-error', NOW(), 500, 1, 'error', $2) RETURNING id`,
      [providerId, agentLabel],
    );
    assert.ok(insert.rows[0].id, "old CHECK accepts 'error'");

    // And new values are rejected post-down.
    await assert.rejects(
      pool.query(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
           latency_ms, classification, agent_id)
         VALUES ($1, '/reject-new', NOW(), 500, 1, 'server_error', $2)`,
        [providerId, agentLabel],
      ),
      /classification_check/,
      "post-down CHECK must reject 'server_error'",
    );
  });
});
