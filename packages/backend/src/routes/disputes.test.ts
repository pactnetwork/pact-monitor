// POST /api/v1/disputes integration tests.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { query, getOne, pool } from "../db.js";
import { disputesRoutes } from "./disputes.js";

async function buildApp() {
  const app = Fastify();
  await app.register(disputesRoutes);
  return app;
}

const tag = randomUUID().slice(0, 8);
const hostname = `disp-${tag}.example.com`;

const merchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
const merchantPubkey = merchantKp.publicKey.toBase58();
const merchantApiKey = `pact_merchant_${randomBytes(16).toString("hex")}`;
const merchantKeyHash = createHash("sha256").update(merchantApiKey).digest("hex");
const merchantLabel = `merchant-disp-${tag}`;

const otherMerchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
const otherMerchantPubkey = otherMerchantKp.publicKey.toBase58();
const otherApiKey = `pact_other_${randomBytes(16).toString("hex")}`;
const otherKeyHash = createHash("sha256").update(otherApiKey).digest("hex");
const otherLabel = `merchant-other-${tag}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let providerId = "";
let myCallRecordId = "";
let othersCallRecordId = "";
const ticketIds: string[] = [];

before(async () => {
  app = await buildApp();
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'merchant')",
    [merchantKeyHash, merchantLabel, merchantPubkey],
  );
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'merchant')",
    [otherKeyHash, otherLabel, otherMerchantPubkey],
  );
  const prov = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
    [hostname, hostname],
  );
  providerId = prov!.id;
  // Two call_records: one attributed to merchant, one to otherMerchant.
  const mine = await getOne<{ id: string }>(
    `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
       latency_ms, classification, origin, merchant_pubkey)
     VALUES ($1, '/v1/foo', NOW(), 500, 100, 'server_error', 'merchant', $2)
     RETURNING id`,
    [providerId, merchantPubkey],
  );
  myCallRecordId = mine!.id;
  const theirs = await getOne<{ id: string }>(
    `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
       latency_ms, classification, origin, merchant_pubkey)
     VALUES ($1, '/v1/foo', NOW(), 500, 100, 'server_error', 'merchant', $2)
     RETURNING id`,
    [providerId, otherMerchantPubkey],
  );
  othersCallRecordId = theirs!.id;
});

after(async () => {
  if (ticketIds.length > 0) {
    await query(`DELETE FROM dispute_tickets WHERE id = ANY($1::uuid[])`, [ticketIds]);
  }
  await query("DELETE FROM dispute_tickets WHERE merchant_pubkey = $1", [merchantPubkey]);
  await query("DELETE FROM call_records WHERE id IN ($1, $2)", [
    myCallRecordId,
    othersCallRecordId,
  ]);
  await query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
  await query("DELETE FROM api_keys WHERE key_hash IN ($1, $2)", [
    merchantKeyHash,
    otherKeyHash,
  ]);
  await app.close();
  await pool.end();
});

describe("POST /api/v1/disputes", () => {
  it("opens a ticket when merchant disputes a call attributed to them", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/disputes",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        callRecordId: myCallRecordId,
        reason: "Response was valid; agent's expectedSchema was wrong",
        evidence: { responseHash: "abc123" },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ticketId: string; status: string };
    assert.ok(body.ticketId);
    assert.equal(body.status, "open");
    ticketIds.push(body.ticketId);

    const row = await getOne<{
      merchant_pubkey: string;
      reason: string;
      status: string;
    }>(
      "SELECT merchant_pubkey, reason, status FROM dispute_tickets WHERE id = $1",
      [body.ticketId],
    );
    assert.equal(row?.merchant_pubkey, merchantPubkey);
    assert.equal(row?.status, "open");
  });

  it("returns 403 when merchant disputes a call attributed to a different merchant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/disputes",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        callRecordId: othersCallRecordId,
        reason: "trying to dispute someone else's call",
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it("returns 404 for an unknown callRecordId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/disputes",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: {
        callRecordId: "00000000-0000-0000-0000-000000000000",
        reason: "doesn't matter",
      },
    });
    assert.equal(res.statusCode, 404);
  });

  it("returns 400 on missing reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/disputes",
      headers: {
        authorization: `Bearer ${merchantApiKey}`,
        "content-type": "application/json",
      },
      payload: { callRecordId: myCallRecordId },
    });
    assert.equal(res.statusCode, 400);
  });
});
