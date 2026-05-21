// POST /api/v1/endpoint/register + GET /api/v1/endpoint/register/:id
// integration tests. Requires DATABASE_URL pointing at a Postgres with the
// Commit 2 migration applied (merchant_endpoints table).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { query, getOne, pool } from "../db.js";
import { endpointRegisterRoutes } from "./endpoint-register.js";

async function buildApp() {
  const app = Fastify();
  await app.register(endpointRegisterRoutes);
  return app;
}

const tag = randomUUID().slice(0, 8);
const merchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
const merchantPubkey = merchantKp.publicKey.toBase58();
const merchantApiKey = `pact_merchant_${randomBytes(16).toString("hex")}`;
const merchantKeyHash = createHash("sha256").update(merchantApiKey).digest("hex");
const merchantLabel = `merchant-er-${tag}`;
const hostname = `er-${tag}.example.com`;

const agentApiKey = `pact_agent_${randomBytes(16).toString("hex")}`;
const agentKeyHash = createHash("sha256").update(agentApiKey).digest("hex");
const agentLabel = `agent-er-${tag}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let createdIds: string[] = [];

before(async () => {
  app = await buildApp();
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'merchant')",
    [merchantKeyHash, merchantLabel, merchantPubkey],
  );
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'agent')",
    [agentKeyHash, agentLabel, Keypair.generate().publicKey.toBase58()],
  );
});

after(async () => {
  if (createdIds.length > 0) {
    await query(
      `DELETE FROM merchant_endpoints WHERE id = ANY($1::uuid[])`,
      [createdIds],
    );
  }
  await query("DELETE FROM merchant_endpoints WHERE merchant_pubkey = $1", [
    merchantPubkey,
  ]);
  await query("DELETE FROM api_keys WHERE key_hash IN ($1, $2)", [
    merchantKeyHash,
    agentKeyHash,
  ]);
  await app.close();
  await pool.end();
});

describe("POST /api/v1/endpoint/register", () => {
  it("creates pending_review rows for each endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/endpoint/register",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        hostname,
        category: "AI generation",
        endpoints: [
          { path: "/v1/generate-image", amountUsd: 0.05 },
          { path: "/v1/generate-video", amountUsd: 1.0 },
        ],
        preferredRateBps: 150,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      registrations: Array<{ id: string; path: string; status: string }>;
      etaHours: number;
    };
    assert.equal(body.registrations.length, 2);
    for (const r of body.registrations) {
      assert.equal(r.status, "pending_review");
      assert.ok(r.id);
      createdIds.push(r.id);
    }
    const dbRow = await getOne<{
      preferred_rate_bps: number;
      amount_usd: string;
    }>(
      "SELECT preferred_rate_bps, amount_usd::text FROM merchant_endpoints WHERE id = $1",
      [body.registrations[0].id],
    );
    assert.equal(dbRow?.preferred_rate_bps, 150);
    assert.equal(parseFloat(dbRow!.amount_usd), 0.05);
  });

  it("UPSERTs on conflict, updating amount_usd + preferred_rate_bps", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/endpoint/register",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        hostname,
        endpoints: [{ path: "/v1/generate-image", amountUsd: 0.07 }],
        preferredRateBps: 200,
      },
    });
    assert.equal(res.statusCode, 200);
    const dbRow = await getOne<{
      preferred_rate_bps: number;
      amount_usd: string;
    }>(
      "SELECT preferred_rate_bps, amount_usd::text FROM merchant_endpoints WHERE merchant_pubkey = $1 AND hostname = $2 AND endpoint_path = $3",
      [merchantPubkey, hostname, "/v1/generate-image"],
    );
    assert.equal(dbRow?.preferred_rate_bps, 200);
    assert.equal(parseFloat(dbRow!.amount_usd), 0.07);
  });

  it("returns 400 on empty endpoints array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/endpoint/register",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: { hostname, endpoints: [] },
    });
    assert.equal(res.statusCode, 400);
  });

  it("returns 400 on amountUsd <= 0", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/endpoint/register",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        hostname,
        endpoints: [{ path: "/bad", amountUsd: 0 }],
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it("returns 403 WrongRole for an agent key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/endpoint/register",
      headers: {
        authorization: `Bearer ${agentApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        hostname,
        endpoints: [{ path: "/v1/x", amountUsd: 0.01 }],
      },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe("GET /api/v1/endpoint/register/:id", () => {
  it("returns the registration for the owning merchant", async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/endpoint/register/${id}`,
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.id, id);
    assert.equal(body.status, "pending_review");
  });

  it("returns 403 when read by a different merchant", async () => {
    const otherMerchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
    const otherApiKey = `pact_other_${randomBytes(16).toString("hex")}`;
    const otherHash = createHash("sha256").update(otherApiKey).digest("hex");
    const otherLabel = `merchant-other-${tag}`;
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'merchant')",
      [otherHash, otherLabel, otherMerchantKp.publicKey.toBase58()],
    );
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/endpoint/register/${createdIds[0]}`,
        headers: { authorization: `Bearer ${otherApiKey}` },
      });
      assert.equal(res.statusCode, 403);
    } finally {
      await query("DELETE FROM api_keys WHERE key_hash = $1", [otherHash]);
    }
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/endpoint/register/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(res.statusCode, 404);
  });
});
