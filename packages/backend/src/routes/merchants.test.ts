// Tests for GET /api/v1/merchants and GET /api/v1/merchants/me/stats.
// Shared singleton pool: end it once at the very end of the file via the
// outermost after hook, not per-describe.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { query, pool } from "../db.js";
import { merchantsRoutes } from "./merchants.js";

async function buildApp() {
  const app = Fastify();
  await app.register(merchantsRoutes);
  return app;
}

const tag = randomUUID().slice(0, 8);
const merchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
const merchantPubkey = merchantKp.publicKey.toBase58();
const merchantApiKey = `pact_merchant_${randomBytes(16).toString("hex")}`;
const merchantKeyHash = createHash("sha256").update(merchantApiKey).digest("hex");
const merchantLabel = `merchant-stats-${tag}`;

const agentApiKey = `pact_agent_${randomBytes(16).toString("hex")}`;
const agentKeyHash = createHash("sha256").update(agentApiKey).digest("hex");
const agentLabel = `agent-stats-${tag}`;
const agentPubkey = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey).publicKey.toBase58();

let listApp: Awaited<ReturnType<typeof buildApp>>;
let statsApp: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  listApp = await buildApp();
  statsApp = await buildApp();
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'merchant')",
    [merchantKeyHash, merchantLabel, merchantPubkey],
  );
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'agent')",
    [agentKeyHash, agentLabel, agentPubkey],
  );
});

after(async () => {
  await query("DELETE FROM api_keys WHERE key_hash IN ($1, $2)", [
    merchantKeyHash,
    agentKeyHash,
  ]);
  await listApp.close();
  await statsApp.close();
  await pool.end();
});

describe("GET /api/v1/merchants", () => {
  it("includes the merchant we created (no hostnames yet) and returns an ETag", async () => {
    const res = await listApp.inject({ method: "GET", url: "/api/v1/merchants" });
    assert.equal(res.statusCode, 200);
    const json = res.json() as {
      merchants: Array<{ pubkey: string; label: string; hostnames: string[] }>;
      generatedAt: string;
    };
    const mine = json.merchants.find((m) => m.pubkey === merchantPubkey);
    assert.ok(mine, "expected our merchant pubkey in v_active_merchants");
    assert.equal(mine!.label, merchantLabel);
    // No active merchant_endpoints rows in this fixture — hostnames is [].
    assert.deepEqual(mine!.hostnames, []);
    assert.ok(json.generatedAt);
    assert.ok(res.headers["etag"]);
  });

  it("returns 304 when If-None-Match matches the current ETag", async () => {
    const first = await listApp.inject({ method: "GET", url: "/api/v1/merchants" });
    const etag = first.headers["etag"] as string;
    const second = await listApp.inject({
      method: "GET",
      url: "/api/v1/merchants",
      headers: { "if-none-match": etag },
    });
    assert.equal(second.statusCode, 304);
  });

  it("surfaces hostnames once a merchant_endpoints row is active", async () => {
    const host = `mh-${tag}.example.com`;
    const ep = await query<{ id: string }>(
      `INSERT INTO merchant_endpoints (
         merchant_pubkey, hostname, endpoint_path, amount_usd,
         preferred_rate_bps, status
       ) VALUES ($1, $2, '/v1/x', 0.01, 100, 'active') RETURNING id`,
      [merchantPubkey, host],
    );
    try {
      const res = await listApp.inject({
        method: "GET",
        url: "/api/v1/merchants",
      });
      const json = res.json() as {
        merchants: Array<{ pubkey: string; hostnames: string[] }>;
      };
      const mine = json.merchants.find((m) => m.pubkey === merchantPubkey);
      assert.ok(mine);
      assert.ok(mine!.hostnames.includes(host));
    } finally {
      await query("DELETE FROM merchant_endpoints WHERE id = $1", [ep.rows[0].id]);
    }
  });
});

describe("GET /api/v1/merchants/me/stats", () => {
  it("returns the zeroed shape for a merchant key", async () => {
    const res = await statsApp.inject({
      method: "GET",
      url: "/api/v1/merchants/me/stats",
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(res.statusCode, 200);
    const json = res.json() as Record<string, unknown>;
    assert.equal(json.calls, 0);
    assert.equal(json.tier, "UNRANKED");
    assert.equal(json.premiumsCollectedUsdc, "0");
  });

  it("returns 403 WrongRole for an agent key", async () => {
    const res = await statsApp.inject({
      method: "GET",
      url: "/api/v1/merchants/me/stats",
      headers: { authorization: `Bearer ${agentApiKey}` },
    });
    assert.equal(res.statusCode, 403);
  });
});
