// GET /api/v1/records/peek tests (B3).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { query, getOne, pool } from "../db.js";
import { recordsRoutes } from "./records.js";

async function buildApp() {
  const app = Fastify();
  await app.register(recordsRoutes);
  return app;
}

const tag = randomUUID().slice(0, 8);
const hostname = `peek-${tag}.example.com`;
const agentKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
const agentPubkey = agentKp.publicKey.toBase58();
const agentApiKey = `pact_agent_${randomBytes(16).toString("hex")}`;
const agentKeyHash = createHash("sha256").update(agentApiKey).digest("hex");
const agentLabel = `agent-peek-${tag}`;

const otherAgentKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
const otherAgentPubkey = otherAgentKp.publicKey.toBase58();
const otherApiKey = `pact_other_agent_${randomBytes(16).toString("hex")}`;
const otherKeyHash = createHash("sha256").update(otherApiKey).digest("hex");
const otherLabel = `agent-other-peek-${tag}`;

const merchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
const merchantApiKey = `pact_merchant_peek_${randomBytes(16).toString("hex")}`;
const merchantKeyHash = createHash("sha256").update(merchantApiKey).digest("hex");
const merchantLabel = `merchant-peek-${tag}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let providerId = "";
let recordId = "";
const recordedAt = new Date(1_717_001_000_000);

before(async () => {
  app = await buildApp();
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'agent')",
    [agentKeyHash, agentLabel, agentPubkey],
  );
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'agent')",
    [otherKeyHash, otherLabel, otherAgentPubkey],
  );
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'merchant')",
    [merchantKeyHash, merchantLabel, merchantKp.publicKey.toBase58()],
  );
  const prov = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
    [hostname, hostname],
  );
  providerId = prov!.id;
  const rec = await getOne<{ id: string }>(
    `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
       latency_ms, classification, agent_id, agent_pubkey)
     VALUES ($1, '/v1/peeked', $2, 200, 50, 'success', $3, $4) RETURNING id`,
    [providerId, recordedAt, agentLabel, agentPubkey],
  );
  recordId = rec!.id;
});

after(async () => {
  await query("DELETE FROM call_records WHERE id = $1", [recordId]).catch(() => {});
  await query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
  await query("DELETE FROM api_keys WHERE key_hash IN ($1, $2, $3)", [
    agentKeyHash,
    otherKeyHash,
    merchantKeyHash,
  ]);
  await app.close();
  await pool.end();
});

describe("GET /api/v1/records/peek", () => {
  it("returns exists:true for a recorded (agent_pubkey, started_at, endpoint)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/records/peek?agent_pubkey=${agentPubkey}&started_at=${recordedAt.getTime()}&endpoint=${encodeURIComponent("/v1/peeked")}`,
      headers: { authorization: `Bearer ${agentApiKey}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { exists: true });
  });

  it("returns exists:false when no record matches", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/records/peek?agent_pubkey=${agentPubkey}&started_at=${recordedAt.getTime() + 1}&endpoint=${encodeURIComponent("/v1/peeked")}`,
      headers: { authorization: `Bearer ${agentApiKey}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { exists: false });
  });

  it("returns 403 WrongRole for a merchant key", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/records/peek?agent_pubkey=${agentPubkey}&started_at=${recordedAt.getTime()}&endpoint=${encodeURIComponent("/v1/peeked")}`,
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(res.statusCode, 403);
  });

  it("returns 403 when peeking another agent's pubkey", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/records/peek?agent_pubkey=${otherAgentPubkey}&started_at=${recordedAt.getTime()}&endpoint=${encodeURIComponent("/v1/peeked")}`,
      headers: { authorization: `Bearer ${agentApiKey}` },
    });
    assert.equal(res.statusCode, 403);
  });

  it("returns 400 when required params are missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/records/peek?agent_pubkey=${agentPubkey}`,
      headers: { authorization: `Bearer ${agentApiKey}` },
    });
    assert.equal(res.statusCode, 400);
  });
});
