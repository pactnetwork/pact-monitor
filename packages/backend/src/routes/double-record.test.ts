// L3: adversarial double-record test.
//
// When an agent SDK and a merchant SDK both submit the SAME call (agent via
// POST /api/v1/records, merchant via POST /api/v1/observations with the
// same agent_pubkey + started_at + endpoint), the partial unique index
// idx_call_records_agent_idempotency (schema.sql:60–62) drops the second
// INSERT. Exactly one row in call_records → exactly one claims row → at
// most one premium debit downstream.
//
// The spec's L3 narrative mentions a settler watermark
// (policy_settlements.last_settled_at) as defense-in-depth. The actual
// watermark mechanism in `crank/premium-settler.ts:147–154` is an upsert
// (`ON CONFLICT DO UPDATE`), not a hard-rejecting unique constraint, so
// there's nothing to assert against at the watermark layer. The DB-layer
// dedupe is the operative enforcement and is what this test covers; the
// watermark is exercised by the existing settler tests.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { initDb, query, getOne, pool } from "../db.js";
import { recordsRoutes } from "./records.js";
import { observationsRoutes } from "./observations.js";

async function buildApp() {
  const app = Fastify();
  await app.register(recordsRoutes);
  await app.register(observationsRoutes);
  return app;
}

function canonicalSig(body: object, sk: Uint8Array): string {
  const serialized = JSON.stringify(body, Object.keys(body as Record<string, unknown>).sort());
  const hash = createHash("sha256").update(serialized).digest();
  return Buffer.from(nacl.sign.detached(hash, sk)).toString("base64");
}

describe("L3 adversarial double-record (agent /records + merchant /observations)", () => {
  const tag = randomUUID().slice(0, 8);
  const hostname = `dbl-${tag}.example.com`;

  const merchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
  const merchantPubkey = merchantKp.publicKey.toBase58();
  const merchantApiKey = `pact_merchant_${randomBytes(16).toString("hex")}`;
  const merchantKeyHash = createHash("sha256").update(merchantApiKey).digest("hex");
  const merchantLabel = `merchant-dbl-${tag}`;

  const agentKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
  const agentPubkey = agentKp.publicKey.toBase58();
  const agentApiKey = `pact_agent_${randomBytes(16).toString("hex")}`;
  const agentKeyHash = createHash("sha256").update(agentApiKey).digest("hex");
  const agentLabel = `agent-dbl-${tag}`;

  let app: Awaited<ReturnType<typeof buildApp>>;
  let providerId = "";
  let merchantEndpointId = "";
  const insertedRecordIds: string[] = [];

  before(async () => {
    await initDb();
    app = await buildApp();

    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role, status) VALUES ($1, $2, $3, 'merchant', 'active')",
      [merchantKeyHash, merchantLabel, merchantPubkey],
    );
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role, status) VALUES ($1, $2, $3, 'agent', 'active')",
      [agentKeyHash, agentLabel, agentPubkey],
    );
    const prov = await getOne<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
      [hostname, hostname],
    );
    providerId = prov!.id;
    // Active merchant_endpoints row so the merchant observation flow can
    // price the claim (Commit 2 B.1 wiring).
    const ep = await getOne<{ id: string }>(
      `INSERT INTO merchant_endpoints (
         merchant_pubkey, hostname, endpoint_path, amount_usd,
         preferred_rate_bps, status
       ) VALUES ($1, $2, '/v1/dbl', 0.05, 100, 'active') RETURNING id`,
      [merchantPubkey, hostname],
    );
    merchantEndpointId = ep!.id;
  });

  after(async () => {
    if (insertedRecordIds.length) {
      await query("DELETE FROM claims WHERE call_record_id = ANY($1::uuid[])", [
        insertedRecordIds,
      ]).catch(() => {});
      await query("DELETE FROM call_records WHERE id = ANY($1::uuid[])", [
        insertedRecordIds,
      ]).catch(() => {});
    }
    if (merchantEndpointId) {
      await query("DELETE FROM merchant_endpoints WHERE id = $1", [merchantEndpointId]);
    }
    if (providerId) {
      await query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
    }
    await query("DELETE FROM api_keys WHERE key_hash IN ($1, $2)", [
      merchantKeyHash,
      agentKeyHash,
    ]);
    await app.close();
  });

  // The dedupe key is (agent_pubkey, timestamp, endpoint) per the partial
  // unique index. Both surfaces must write THE SAME timestamp/endpoint
  // pair for dedupe to fire. The agent uses ISO timestamp; the merchant
  // uses ms-epoch (converted to Date inside observations.ts). We pick a
  // sane integer ms-epoch and feed it as both startedAt (merchant) and
  // ISO (agent) so the resulting Date matches.
  const FIXED_MS = 1_717_555_000_000;

  it("agent posts first, merchant posts identical tuple → DB drops the merchant INSERT", async () => {
    // 1. Agent /records.
    const agentBody = {
      records: [
        {
          hostname,
          endpoint: "/v1/dbl",
          timestamp: new Date(FIXED_MS).toISOString(),
          status_code: 503,
          latency_ms: 100,
          classification: "server_error",
          payment_protocol: "x402",
          payment_amount: 50_000,
          payment_asset: "USDC",
          payment_network: "solana",
        },
      ],
    };
    const recRes = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      headers: {
        authorization: `Bearer ${agentApiKey}`,
        "content-type": "application/json",
      },
      payload: agentBody,
    });
    assert.equal(recRes.statusCode, 200);
    assert.equal((recRes.json() as { accepted: number }).accepted, 1);

    // 2. Merchant /observations with the EXACT same dedupe tuple.
    const obsBody = {
      hostname,
      endpoint: "/v1/dbl",
      startedAt: FIXED_MS,
      statusCode: 503,
      latencyMs: 100,
      classification: "server_error",
      agentPubkey,
    };
    const obsSig = canonicalSig(obsBody, merchantKp.secretKey);
    const obsRes = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
        "x-pact-pubkey": merchantPubkey,
        "x-pact-signature": obsSig,
      },
      payload: obsBody,
    });
    assert.equal(obsRes.statusCode, 200);
    assert.equal(
      (obsRes.json() as { accepted: number }).accepted,
      0,
      "merchant submission must be dropped by ON CONFLICT DO NOTHING",
    );

    // 3. Assert exactly one call_records row for the dedupe tuple.
    const rows = await query<{ id: string; origin: string }>(
      `SELECT id, origin FROM call_records
        WHERE agent_pubkey = $1 AND timestamp = $2 AND endpoint = $3`,
      [agentPubkey, new Date(FIXED_MS), "/v1/dbl"],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].origin, "agent");
    insertedRecordIds.push(rows.rows[0].id);

    // 4. Assert exactly one claims row.
    const claims = await query(
      "SELECT id FROM claims WHERE call_record_id = $1",
      [rows.rows[0].id],
    );
    assert.equal(claims.rowCount, 1);
  });

  it("merchant posts first, agent re-submits identical tuple → DB drops the agent INSERT", async () => {
    const ts = FIXED_MS + 60_000; // different from the first test's row
    const obsBody = {
      hostname,
      endpoint: "/v1/dbl",
      startedAt: ts,
      statusCode: 503,
      latencyMs: 100,
      classification: "server_error",
      agentPubkey,
    };
    const obsSig = canonicalSig(obsBody, merchantKp.secretKey);
    const obsRes = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
        "x-pact-pubkey": merchantPubkey,
        "x-pact-signature": obsSig,
      },
      payload: obsBody,
    });
    assert.equal(obsRes.statusCode, 200);
    assert.equal((obsRes.json() as { accepted: number }).accepted, 1);

    // Agent then submits the same tuple via /records.
    const agentBody = {
      records: [
        {
          hostname,
          endpoint: "/v1/dbl",
          timestamp: new Date(ts).toISOString(),
          status_code: 503,
          latency_ms: 100,
          classification: "server_error",
          payment_protocol: "x402",
          payment_amount: 50_000,
          payment_asset: "USDC",
          payment_network: "solana",
        },
      ],
    };
    const recRes = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      headers: {
        authorization: `Bearer ${agentApiKey}`,
        "content-type": "application/json",
      },
      payload: agentBody,
    });
    assert.equal(recRes.statusCode, 200);
    // The agent's /records response shape uses `accepted` as the count
    // landed THIS POST; the ON CONFLICT skip ensures it's 0 here.
    assert.equal(
      (recRes.json() as { accepted: number }).accepted,
      0,
      "agent re-submission must be dropped by ON CONFLICT DO NOTHING",
    );

    // Exactly one row for the (agent_pubkey, ts, endpoint) tuple, origin
    // is 'merchant' because the merchant landed first.
    const rows = await query<{ id: string; origin: string }>(
      `SELECT id, origin FROM call_records
        WHERE agent_pubkey = $1 AND timestamp = $2 AND endpoint = $3`,
      [agentPubkey, new Date(ts), "/v1/dbl"],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].origin, "merchant");
    insertedRecordIds.push(rows.rows[0].id);
  });
});
