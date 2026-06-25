// Tests for GET /api/v1/merchants and GET /api/v1/merchants/me/stats.
// Shared singleton pool: end it once at the very end of the file via the
// outermost after hook, not per-describe.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { query, getOne, pool } from "../db.js";
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

describe("GET /api/v1/merchants/me/referrals (Commit 3 K4)", () => {
  // Aggregation fixtures: the merchant key acts as the referrer for a few
  // claims attributed to two distinct agent labels (so byAgent has 2 rows).
  const agentLabel1 = `agent-ref-${tag}-1`;
  const agentLabel2 = `agent-ref-${tag}-2`;
  const agentPubkey1 = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey)
    .publicKey.toBase58();
  const agentPubkey2 = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey)
    .publicKey.toBase58();
  const agentKeyHash1 = createHash("sha256").update(`hash-ref-${tag}-1`).digest("hex");
  const agentKeyHash2 = createHash("sha256").update(`hash-ref-${tag}-2`).digest("hex");

  let providerId = "";
  const callRecordIds: string[] = [];
  const claimIds: string[] = [];

  before(async () => {
    // Two agent api_keys rows so the JOIN in getReferralsForReferrer can
    // map claims.agent_id → agent_pubkey.
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'agent')",
      [agentKeyHash1, agentLabel1, agentPubkey1],
    );
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, 'agent')",
      [agentKeyHash2, agentLabel2, agentPubkey2],
    );

    const prov = await getOne<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
      [`ref-${tag}.example.com`, `ref-${tag}.example.com`],
    );
    providerId = prov!.id;

    // Insert call_records + claims directly with referrer_pubkey set.
    // Two claims attributed to agent1 (refunds 30000 + 50000), one to agent2 (refund 20000).
    for (const [label, refund] of [
      [agentLabel1, 30_000],
      [agentLabel1, 50_000],
      [agentLabel2, 20_000],
    ] as Array<[string, number]>) {
      const ts = new Date(Date.now() - 60_000); // a minute ago
      const cr = await getOne<{ id: string }>(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
           latency_ms, classification, agent_id, agent_pubkey)
         VALUES ($1, '/v1/x', $2, 503, 100, 'server_error', $3, $4) RETURNING id`,
        [providerId, ts, label, label === agentLabel1 ? agentPubkey1 : agentPubkey2],
      );
      callRecordIds.push(cr!.id);
      const cl = await getOne<{ id: string }>(
        `INSERT INTO claims (call_record_id, provider_id, agent_id, trigger_type,
           call_cost, refund_pct, refund_amount, status, referrer_pubkey)
         VALUES ($1, $2, $3, 'server_error', $4, 100, $4, 'simulated', $5)
         RETURNING id`,
        [cr!.id, providerId, label, refund, merchantPubkey],
      );
      claimIds.push(cl!.id);
    }
  });

  after(async () => {
    if (claimIds.length) {
      await query("DELETE FROM claims WHERE id = ANY($1::uuid[])", [claimIds]);
    }
    if (callRecordIds.length) {
      await query("DELETE FROM call_records WHERE id = ANY($1::uuid[])", [callRecordIds]);
    }
    if (providerId) {
      await query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
    }
    await query("DELETE FROM api_keys WHERE key_hash IN ($1, $2)", [
      agentKeyHash1,
      agentKeyHash2,
    ]);
  });

  it("returns per-agent breakdown + total scoped to the merchant's pubkey", async () => {
    const res = await statsApp.inject({
      method: "GET",
      url: "/api/v1/merchants/me/referrals",
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      totalRefShareUsdc: string;
      byAgent: Array<{ agentPubkey: string; calls: number; refShareUsdc: string }>;
    };
    assert.equal(body.totalRefShareUsdc, "100000"); // 30000 + 50000 + 20000
    assert.equal(body.byAgent.length, 2);
    const a1 = body.byAgent.find((a) => a.agentPubkey === agentPubkey1)!;
    const a2 = body.byAgent.find((a) => a.agentPubkey === agentPubkey2)!;
    assert.ok(a1);
    assert.equal(a1.calls, 2);
    assert.equal(a1.refShareUsdc, "80000");
    assert.ok(a2);
    assert.equal(a2.calls, 1);
    assert.equal(a2.refShareUsdc, "20000");
  });

  it("?since filters out older claims", async () => {
    // since = now + 60s — well past every fixture row.
    const futureSince = Date.now() + 60_000;
    const res = await statsApp.inject({
      method: "GET",
      url: `/api/v1/merchants/me/referrals?since=${futureSince}`,
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      totalRefShareUsdc: string;
      byAgent: unknown[];
    };
    assert.equal(body.totalRefShareUsdc, "0");
    assert.equal(body.byAgent.length, 0);
  });

  it("returns 400 InvalidSince on non-numeric since", async () => {
    const res = await statsApp.inject({
      method: "GET",
      url: "/api/v1/merchants/me/referrals?since=not-a-number",
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(res.statusCode, 400);
  });

  it("returns 403 WrongRole for an agent key", async () => {
    const res = await statsApp.inject({
      method: "GET",
      url: "/api/v1/merchants/me/referrals",
      headers: { authorization: `Bearer ${agentApiKey}` },
    });
    assert.equal(res.statusCode, 403);
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
