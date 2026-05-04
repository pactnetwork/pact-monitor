import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import Fastify from "fastify";
import { initDb, query, pool } from "../db.js";
import {
  __resetNetworkCacheForTests,
  __setNetworkCacheForTests,
} from "../utils/network.js";
import { keysRoutes } from "./keys.js";

async function buildApp() {
  const app = Fastify();
  await app.register(keysRoutes);
  return app;
}

describe("POST /api/v1/keys/self-serve", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  // Per-suite label prefix so cleanup doesn't sweep unrelated rows.
  const SUITE_TAG = `keys-test-${randomUUID().slice(0, 8)}`;

  before(async () => {
    await initDb();
    app = await buildApp();
  });

  after(async () => {
    await query(
      "DELETE FROM api_keys WHERE label LIKE 'self-serve-%' AND label LIKE '%' || $1 || '%' OR agent_pubkey = ANY($2)",
      [SUITE_TAG, []],
    );
    // Looser cleanup: drop any self-serve keys for the test pubkeys we
    // generated in this run. Pubkeys are random per-test so collisions are
    // negligible.
    await app.close();
    await pool.end();
  });

  beforeEach(() => {
    __resetNetworkCacheForTests();
    __setNetworkCacheForTests("devnet");
  });

  it("returns 410 when network is mainnet (devnet-only gate)", async () => {
    __setNetworkCacheForTests("mainnet-beta");
    const kp = Keypair.generate();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: { agent_pubkey: kp.publicKey.toBase58() },
    });
    assert.equal(res.statusCode, 410);
    const body = res.json();
    assert.equal(body.error, "SelfServeDisabled");
    assert.equal(body.network, "mainnet-beta");
  });

  it("returns 410 when network is unknown (fail-closed default)", async () => {
    __setNetworkCacheForTests("unknown");
    const kp = Keypair.generate();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: { agent_pubkey: kp.publicKey.toBase58() },
    });
    assert.equal(res.statusCode, 410);
    const body = res.json();
    assert.equal(body.error, "SelfServeDisabled");
    assert.equal(body.network, "unknown");
  });

  it("returns 410 when network is testnet", async () => {
    __setNetworkCacheForTests("testnet");
    const kp = Keypair.generate();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: { agent_pubkey: kp.publicKey.toBase58() },
    });
    assert.equal(res.statusCode, 410);
  });

  it("returns 400 for missing agent_pubkey", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, "InvalidAgentPubkey");
  });

  it("returns 400 for malformed agent_pubkey", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: { agent_pubkey: "not-a-pubkey" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, "InvalidAgentPubkey");
  });

  it("returns 201 with a fresh API key bound to the agent_pubkey", async () => {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: { agent_pubkey: pubkey },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.match(body.apiKey, /^pact_[0-9a-f]{48}$/);
    assert.equal(body.agentPubkey, pubkey);
    assert.equal(body.network, "devnet");
    assert.match(body.label, /^self-serve-[A-Za-z0-9]{8}-\d+$/);

    // Verify the row landed in api_keys with the right binding.
    const row = await query<{ agent_pubkey: string; status: string }>(
      "SELECT agent_pubkey, status FROM api_keys WHERE label = $1",
      [body.label],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].agent_pubkey, pubkey);
    assert.equal(row.rows[0].status, "active");

    await query("DELETE FROM api_keys WHERE label = $1", [body.label]);
  });

  it("rejects pubkey when agent already has 5 active self-serve keys", async () => {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();

    // Pre-seed 5 self-serve rows for this pubkey directly in the DB so we
    // don't have to fight the per-pubkey rate limiter for this test.
    for (let i = 0; i < 5; i++) {
      await query(
        "INSERT INTO api_keys (key_hash, label, agent_pubkey, status) VALUES ($1, $2, $3, 'active')",
        [`hash-${SUITE_TAG}-${i}`, `self-serve-cap-${SUITE_TAG}-${i}`, pubkey],
      );
    }

    // Build a fresh app instance so we get a clean per-pubkey rate-limit
    // bucket — otherwise the 5 inserts above would pass under the limit but
    // the 6th request on the SAME app would still see the pubkey under its
    // window. (The fastify-rate-limit hook keys on body.agent_pubkey.)
    const freshApp = await buildApp();
    try {
      const res = await freshApp.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: { agent_pubkey: pubkey },
      });
      assert.equal(res.statusCode, 429);
      const body = res.json();
      assert.equal(body.error, "TooManyKeysForPubkey");
      assert.equal(body.agentPubkey, pubkey);
    } finally {
      await freshApp.close();
      await query("DELETE FROM api_keys WHERE label LIKE $1", [
        `self-serve-cap-${SUITE_TAG}-%`,
      ]);
    }
  });

  it("rate-limits a second issuance for the same pubkey within the window", async () => {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: { agent_pubkey: pubkey },
    });
    assert.equal(first.statusCode, 201);
    const firstLabel = first.json().label;

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: { agent_pubkey: pubkey },
    });
    // The second request hits the @fastify/rate-limit window (1 per pubkey
    // per hour). Status 429 is the contract.
    assert.equal(second.statusCode, 429);

    await query("DELETE FROM api_keys WHERE label = $1", [firstLabel]);
  });
});
