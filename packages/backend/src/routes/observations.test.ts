// Tests for POST /api/v1/observations (merchant SDK Commit 1 stub).
// Requires DATABASE_URL pointing at a Postgres with the merchant migration
// applied (idx_call_records_agent_idempotency + role + origin columns).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { query, getOne, pool } from "../db.js";
import { observationsRoutes } from "./observations.js";

async function buildApp() {
  const app = Fastify();
  await app.register(observationsRoutes);
  return app;
}

function canonicalSig(body: object, sk: Uint8Array): string {
  const serialized = JSON.stringify(body, Object.keys(body as Record<string, unknown>).sort());
  const hash = createHash("sha256").update(serialized).digest();
  return Buffer.from(nacl.sign.detached(hash, sk)).toString("base64");
}

describe("POST /api/v1/observations", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const tag = randomUUID().slice(0, 8);
  const hostname = `obs-${tag}.example.com`;

  const merchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
  const merchantPubkey = merchantKp.publicKey.toBase58();
  const merchantApiKey = `pact_merchant_${randomBytes(16).toString("hex")}`;
  const merchantKeyHash = createHash("sha256").update(merchantApiKey).digest("hex");
  const merchantLabel = `merchant-${tag}`;

  const agentKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
  const agentPubkey = agentKp.publicKey.toBase58();
  const agentApiKey = `pact_agent_${randomBytes(16).toString("hex")}`;
  const agentKeyHash = createHash("sha256").update(agentApiKey).digest("hex");
  const agentLabel = `agent-${tag}`;

  let providerId = "";
  const insertedRecordIds: string[] = [];

  before(async () => {
    app = await buildApp();
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'merchant')",
      [merchantKeyHash, merchantLabel, merchantPubkey],
    );
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'agent')",
      [agentKeyHash, agentLabel, agentPubkey],
    );
    // Pre-create the provider so DELETE in after() can clean up deterministically.
    const prov = await getOne<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
      [hostname, hostname],
    );
    providerId = prov!.id;
  });

  after(async () => {
    for (const id of insertedRecordIds) {
      await query("DELETE FROM call_records WHERE id = $1", [id]).catch(() => {});
    }
    await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]).catch(() => {});
    await query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
    await query("DELETE FROM api_keys WHERE key_hash IN ($1, $2)", [
      merchantKeyHash,
      agentKeyHash,
    ]);
    await app.close();
    await pool.end();
  });

  it("accepts a signed merchant observation and writes origin='merchant'", async () => {
    const body = {
      hostname,
      endpoint: "/v1/foo",
      startedAt: 1_717_000_000_000,
      statusCode: 200,
      latencyMs: 12,
      classification: "success",
      agentPubkey,
    };
    const sig = canonicalSig(body, merchantKp.secretKey);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
        "x-pact-pubkey": merchantPubkey,
        "x-pact-signature": sig,
      },
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    const json = res.json() as { accepted: number; recordId?: string };
    assert.equal(json.accepted, 1);
    assert.ok(json.recordId);
    insertedRecordIds.push(json.recordId!);

    const row = await getOne<{
      origin: string;
      merchant_pubkey: string;
      agent_pubkey: string;
    }>(
      "SELECT origin, merchant_pubkey, agent_pubkey FROM call_records WHERE id = $1",
      [json.recordId],
    );
    assert.equal(row?.origin, "merchant");
    assert.equal(row?.merchant_pubkey, merchantPubkey);
    assert.equal(row?.agent_pubkey, agentPubkey);
  });

  it("returns 409 StartedAtRequired when agentPubkey is present but startedAt is missing", async () => {
    const body = {
      hostname,
      endpoint: "/v1/foo",
      statusCode: 200,
      latencyMs: 12,
      classification: "success",
      agentPubkey,
    };
    const sig = canonicalSig(body, merchantKp.secretKey);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
        "x-pact-pubkey": merchantPubkey,
        "x-pact-signature": sig,
      },
      payload: body,
    });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as { error: string }).error, "StartedAtRequired");
  });

  it("returns accepted=0 on the second submission with the same (agentPubkey, startedAt, endpoint)", async () => {
    const body = {
      hostname,
      endpoint: "/v1/dedupe",
      startedAt: 1_717_000_111_111,
      statusCode: 200,
      latencyMs: 9,
      classification: "success",
      agentPubkey,
    };
    const sig = canonicalSig(body, merchantKp.secretKey);
    const headers = {
      authorization: `Bearer ${merchantApiKey}`,
      "content-type": "application/json",
      "x-pact-pubkey": merchantPubkey,
      "x-pact-signature": sig,
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers,
      payload: body,
    });
    assert.equal(first.statusCode, 200);
    const firstJson = first.json() as { accepted: number; recordId?: string };
    assert.equal(firstJson.accepted, 1);
    if (firstJson.recordId) insertedRecordIds.push(firstJson.recordId);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers,
      payload: body,
    });
    assert.equal(second.statusCode, 200);
    assert.equal((second.json() as { accepted: number }).accepted, 0);
  });

  it("returns 403 WrongRole for an agent-role API key", async () => {
    const body = {
      hostname,
      endpoint: "/v1/forbidden",
      startedAt: 1_717_000_222_222,
      statusCode: 200,
      latencyMs: 9,
      classification: "success",
    };
    const sig = canonicalSig(body, agentKp.secretKey);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers: {
        authorization: `Bearer ${agentApiKey}`,
        "content-type": "application/json",
        "x-pact-pubkey": agentPubkey,
        "x-pact-signature": sig,
      },
      payload: body,
    });
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: string }).error, "WrongRole");
  });

  it("rejects mismatched X-Pact-Pubkey on signature header", async () => {
    const body = {
      hostname,
      endpoint: "/v1/mismatch",
      startedAt: 1_717_000_333_333,
      statusCode: 200,
      latencyMs: 9,
      classification: "success",
    };
    // Sign with merchant's key, but claim a different pubkey in the header.
    const sig = canonicalSig(body, merchantKp.secretKey);
    const wrongPubkey = bs58.encode(nacl.sign.keyPair().publicKey);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
        "x-pact-pubkey": wrongPubkey,
        "x-pact-signature": sig,
      },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
  });

  // Commit 2 graduation: with an active merchant_endpoints row supplying the
  // price, a failure-classified observation should generate a claim row via
  // maybeCreateClaim. The amount_usd flows through as the paymentAmount that
  // claims.ts gates on (claims.ts:52: `if (!paymentAmount) return null`).
  it("creates a claims row when an active merchant_endpoints row exists (Commit 2 B.1)", async () => {
    const failEndpoint = "/v1/claim-path";
    const ep = await query<{ id: string }>(
      `INSERT INTO merchant_endpoints (
         merchant_pubkey, hostname, endpoint_path, amount_usd,
         preferred_rate_bps, status
       ) VALUES ($1, $2, $3, 0.05, 100, 'active') RETURNING id`,
      [merchantPubkey, hostname, failEndpoint],
    );
    try {
      const body = {
        hostname,
        endpoint: failEndpoint,
        startedAt: 1_717_000_444_444,
        statusCode: 503,
        latencyMs: 100,
        classification: "server_error",
        agentPubkey,
      };
      const sig = canonicalSig(body, merchantKp.secretKey);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/observations",
        headers: {
          authorization: `Bearer ${merchantApiKey}`,
          "content-type": "application/json",
          "x-pact-pubkey": merchantPubkey,
          "x-pact-signature": sig,
        },
        payload: body,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json() as { accepted: number; recordId?: string };
      assert.equal(json.accepted, 1);
      if (json.recordId) insertedRecordIds.push(json.recordId);

      // The claim row should exist with refund > 0 (server_error → 100% refund
      // per claims.ts REFUND_PCT).
      const claim = await getOne<{
        trigger_type: string;
        refund_amount: string;
        call_cost: string;
      }>(
        "SELECT trigger_type, refund_amount::text, call_cost::text FROM claims WHERE call_record_id = $1",
        [json.recordId],
      );
      assert.ok(claim, "expected a claims row for the merchant observation");
      assert.equal(claim!.trigger_type, "server_error");
      // amount_usd 0.05 → 50_000 micro-USDC → refund 100% → 50_000.
      assert.equal(claim!.call_cost, "50000");
      assert.equal(claim!.refund_amount, "50000");
    } finally {
      await query("DELETE FROM claims WHERE call_record_id = ANY($1::uuid[])", [
        insertedRecordIds,
      ]).catch(() => {});
      await query("DELETE FROM merchant_endpoints WHERE id = $1", [ep.rows[0].id]);
    }
  });

  // Inverse: NO active merchant_endpoints row → observation persists but no
  // claim (graceful no-op; logged warning only).
  it("skips claim creation when no merchant_endpoints row matches", async () => {
    const body = {
      hostname,
      endpoint: "/v1/unpriced",
      startedAt: 1_717_000_555_555,
      statusCode: 503,
      latencyMs: 100,
      classification: "server_error",
      agentPubkey,
    };
    const sig = canonicalSig(body, merchantKp.secretKey);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/observations",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
        "x-pact-pubkey": merchantPubkey,
        "x-pact-signature": sig,
      },
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    const json = res.json() as { accepted: number; recordId?: string };
    assert.equal(json.accepted, 1);
    if (json.recordId) insertedRecordIds.push(json.recordId);

    const claim = await getOne<{ id: string }>(
      "SELECT id FROM claims WHERE call_record_id = $1",
      [json.recordId],
    );
    assert.equal(claim, null, "no claim should be generated for unpriced endpoints");
  });
});
