// Validation tests for POST /api/v1/records.classification — defends the
// route boundary against old SDKs / stale ~/.pact-monitor/records.jsonl
// retries that emit the legacy "error" enum value. Without route-level
// validation those payloads hit the call_records_classification_check
// CHECK constraint and return 500. With validation they should return 400
// and never reach the database.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import { initDb, query, getOne, pool } from "../db.js";
import { recordsRoutes } from "./records.js";

const TEST_API_KEY = `test-key-${randomUUID()}`;
const TEST_KEY_HASH = createHash("sha256").update(TEST_API_KEY).digest("hex");
const TEST_LABEL = `records-validation-${randomUUID()}`;

async function buildApp() {
  const app = Fastify();
  await app.register(recordsRoutes);
  return app;
}

describe("POST /api/v1/records classification validation", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    await initDb();
    await query(
      "INSERT INTO api_keys (key_hash, label) VALUES ($1, $2) ON CONFLICT (key_hash) DO NOTHING",
      [TEST_KEY_HASH, TEST_LABEL],
    );
    app = await buildApp();
  });

  after(async () => {
    await query("DELETE FROM call_records WHERE agent_id = $1", [TEST_LABEL]);
    await query("DELETE FROM api_keys WHERE key_hash = $1", [TEST_KEY_HASH]);
    await app.close();
    await pool.end();
  });

  it('rejects legacy "error" classification with 400 and writes nothing', async () => {
    const hostname = `legacy-${randomUUID()}.example.com`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      payload: {
        records: [
          {
            hostname,
            endpoint: "/v1/legacy",
            timestamp: new Date().toISOString(),
            status_code: 500,
            latency_ms: 100,
            classification: "error",
          },
        ],
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.match(body.error, /Invalid classification/);
    assert.equal(body.field, "records[0].classification");

    // No DB write should have happened — provider row never created.
    const provider = await getOne<{ id: string }>(
      "SELECT id FROM providers WHERE base_url = $1",
      [hostname],
    );
    assert.equal(provider, null, "no provider row should exist");
    const rec = await getOne<{ id: string }>(
      "SELECT id FROM call_records WHERE endpoint = '/v1/legacy' AND agent_id = $1",
      [TEST_LABEL],
    );
    assert.equal(rec, null, "no call_record should be inserted");
  });

  it("returns the offending index when an invalid classification is mid-batch", async () => {
    const hostname = `mid-batch-${randomUUID()}.example.com`;
    const ts = () => new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      payload: {
        records: [
          { hostname, endpoint: "/a", timestamp: ts(), status_code: 200, latency_ms: 1, classification: "success" },
          { hostname, endpoint: "/b", timestamp: ts(), status_code: 500, latency_ms: 1, classification: "bogus" },
          { hostname, endpoint: "/c", timestamp: ts(), status_code: 200, latency_ms: 1, classification: "success" },
        ],
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.field, "records[1].classification");

    // First valid record must NOT have been inserted because validation
    // happens up-front before the per-record loop.
    const rec = await getOne<{ id: string }>(
      "SELECT id FROM call_records WHERE endpoint = '/a' AND agent_id = $1",
      [TEST_LABEL],
    );
    assert.equal(rec, null, "no partial writes when validation fails");
  });

  for (const valid of [
    "success",
    "timeout",
    "client_error",
    "server_error",
    "schema_mismatch",
  ] as const) {
    it(`accepts valid classification "${valid}" with 200`, async () => {
      const hostname = `valid-${valid}-${randomUUID()}.example.com`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        payload: {
          records: [
            {
              hostname,
              endpoint: `/${valid}`,
              timestamp: new Date().toISOString(),
              status_code: valid === "success" ? 200 : 500,
              latency_ms: 100,
              classification: valid,
            },
          ],
        },
      });
      assert.equal(res.statusCode, 200, `body=${res.body}`);
      const body = res.json();
      assert.equal(body.accepted, 1);

      // Cleanup the provider + call_records inserted by this case.
      const providerId = body.provider_ids[0];
      await query("DELETE FROM claims WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM providers WHERE id = $1", [providerId]);
    });
  }
});
