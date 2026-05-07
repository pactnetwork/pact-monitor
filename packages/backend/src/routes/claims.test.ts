// PR 6: regression test for /api/v1/claims agent_pubkey filter.
// Before this PR the route accepted the query param via Fastify's loose
// querystring schema but the handler never read it — every query returned
// the global claim list, breaking the documented "find my own claims"
// UX in docs/agent-quickstart.md.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { initDb, query } from "../db.js";
import { claimsRoutes } from "./claims.js";

async function buildApp() {
  const app = Fastify();
  await app.register(claimsRoutes);
  return app;
}

describe("GET /api/v1/claims agent_pubkey filter", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  // Two agents with on-chain pubkeys. Each gets one paid call_record + one
  // claim row joined to it. The filter must return only the matching agent's
  // claim and ignore the other.
  const tag = randomUUID().slice(0, 8);
  const PUBKEY_A = `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${tag.slice(0, 2)}`;
  const PUBKEY_B = `BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB${tag.slice(0, 2)}`;
  const HOSTNAME = `claims-filter-${tag}.example`;
  let providerId = "";
  let claimAId = "";
  let claimBId = "";

  before(async () => {
    await initDb();

    const provInsert = await query<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
      [HOSTNAME, HOSTNAME],
    );
    providerId = provInsert.rows[0].id;

    // Two call_records with distinct agent_pubkeys.
    const crA = await query<{ id: string }>(
      `INSERT INTO call_records
        (provider_id, endpoint, timestamp, status_code, latency_ms,
         classification, payment_amount, agent_id, agent_pubkey)
       VALUES ($1, '/x', NOW(), 503, 100, 'server_error', 1000, $2, $3)
       RETURNING id`,
      [providerId, `agent-A-${tag}`, PUBKEY_A],
    );
    const crB = await query<{ id: string }>(
      `INSERT INTO call_records
        (provider_id, endpoint, timestamp, status_code, latency_ms,
         classification, payment_amount, agent_id, agent_pubkey)
       VALUES ($1, '/x', NOW(), 503, 100, 'server_error', 1000, $2, $3)
       RETURNING id`,
      [providerId, `agent-B-${tag}`, PUBKEY_B],
    );

    // One claim for each.
    const clA = await query<{ id: string }>(
      `INSERT INTO claims
        (call_record_id, provider_id, agent_id, trigger_type,
         call_cost, refund_pct, refund_amount, status)
       VALUES ($1, $2, $3, 'server_error', 1000, 100, 1000, 'simulated')
       RETURNING id`,
      [crA.rows[0].id, providerId, `agent-A-${tag}`],
    );
    const clB = await query<{ id: string }>(
      `INSERT INTO claims
        (call_record_id, provider_id, agent_id, trigger_type,
         call_cost, refund_pct, refund_amount, status)
       VALUES ($1, $2, $3, 'server_error', 1000, 100, 1000, 'simulated')
       RETURNING id`,
      [crB.rows[0].id, providerId, `agent-B-${tag}`],
    );
    claimAId = clA.rows[0].id;
    claimBId = clB.rows[0].id;

    app = await buildApp();
  });

  after(async () => {
    // Clean up rows but DO NOT pool.end() — the pg pool is module-scoped
    // and other test files in the same run depend on it. Closing the pool
    // here cancels parallel test files mid-run with "test did not finish
    // before its parent and was cancelled."
    await query("DELETE FROM claims WHERE provider_id = $1", [providerId]);
    await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
    await query("DELETE FROM providers WHERE id = $1", [providerId]);
    await app.close();
  });

  it("filters claims by agent_pubkey (resolves through call_records)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/claims?agent_pubkey=${PUBKEY_A}`,
    });
    assert.equal(res.statusCode, 200);
    const rows = res.json() as Array<{ id: string }>;
    // Only the seeded claim for agent A. Other rows on the dev DB may exist
    // for unrelated agents but must NOT match this pubkey.
    assert.ok(rows.length >= 1, "at least the seeded agent-A claim");
    assert.ok(
      rows.every((r) => r.id !== claimBId),
      "filter must not include agent-B's claim",
    );
    assert.ok(
      rows.some((r) => r.id === claimAId),
      "filter must include agent-A's claim",
    );
  });

  it("agent_pubkey filter combines with provider_id (intersection)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/claims?agent_pubkey=${PUBKEY_A}&provider_id=${providerId}`,
    });
    assert.equal(res.statusCode, 200);
    const rows = res.json() as Array<{ id: string; provider_id: string }>;
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.provider_id === providerId));
    assert.ok(rows.some((r) => r.id === claimAId));
  });

  it("returns empty list for an unknown pubkey", async () => {
    const unknown = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/claims?agent_pubkey=${unknown}`,
    });
    assert.equal(res.statusCode, 200);
    const rows = res.json() as Array<unknown>;
    assert.equal(rows.length, 0);
  });

  it("no agent_pubkey filter returns at least both seeded claims", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/claims?provider_id=${providerId}&limit=200`,
    });
    assert.equal(res.statusCode, 200);
    const rows = res.json() as Array<{ id: string }>;
    const ids = new Set(rows.map((r) => r.id));
    assert.ok(ids.has(claimAId), "global query should include claim A");
    assert.ok(ids.has(claimBId), "global query should include claim B");
  });
});
