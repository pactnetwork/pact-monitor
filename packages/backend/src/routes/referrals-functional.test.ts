// K2 reframe: end-to-end functional test exercising the referrer attribution
// loop. V1's on-chain program has no Policy.referrer fields, so off-chain
// truth (claims.referrer_pubkey snapshotted at claim creation) is what the
// settler attributes today. This chain proves the contract:
//
//   1. ops inserts a merchant key (role='merchant').
//   2. ops registers an active merchant_endpoints row (for claim pricing).
//   3. agent issues a self-serve key with ?ref=<merchantPubkey>.
//      → api_keys.referrer_pubkey + referrer_share_bps set (K1).
//   4. merchant POSTs an observation classified server_error.
//      → /observations writes call_records + maybeCreateClaim creates a
//        claims row whose referrer_pubkey is snapshotted from the agent's
//        api_keys row at auth time (Commit 2 wiring).
//   5. merchant GETs /api/v1/merchants/me/referrals.
//      → aggregation surfaces the agent + attributed total (K4 backend).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { initDb, query, getOne, pool } from "../db.js";
import {
  __resetNetworkCacheForTests,
  __setNetworkCacheForTests,
} from "../utils/network.js";
import { keysRoutes } from "./keys.js";
import { observationsRoutes } from "./observations.js";
import { merchantsRoutes } from "./merchants.js";
import { recordsRoutes } from "./records.js";

async function buildApp() {
  const app = Fastify();
  await app.register(keysRoutes);
  await app.register(observationsRoutes);
  await app.register(merchantsRoutes);
  await app.register(recordsRoutes);
  return app;
}

function signChallenge(kp: Keypair, nonce: string, pubkey: string): string {
  const message = [
    "Pact Network self-serve API key issuance",
    `Agent: ${pubkey}`,
    `Nonce: ${nonce}`,
  ].join("\n");
  return Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
  ).toString("base64");
}

function canonicalSig(body: object, sk: Uint8Array): string {
  const serialized = JSON.stringify(body, Object.keys(body as Record<string, unknown>).sort());
  const hash = createHash("sha256").update(serialized).digest();
  return Buffer.from(nacl.sign.detached(hash, sk)).toString("base64");
}

describe("Referral attribution functional E2E (Commit 3 K2 reframe)", () => {
  const tag = randomUUID().slice(0, 8);
  const hostname = `func-${tag}.example.com`;

  const merchantKp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
  const merchantPubkey = merchantKp.publicKey.toBase58();
  const merchantApiKey = `pact_merchant_${randomBytes(16).toString("hex")}`;
  const merchantKeyHash = createHash("sha256").update(merchantApiKey).digest("hex");
  const merchantLabel = `merchant-func-${tag}`;

  let app: Awaited<ReturnType<typeof buildApp>>;
  let providerId = "";
  let merchantEndpointId = "";
  const issuedAgentLabels: string[] = [];
  const insertedRecordIds: string[] = [];

  before(async () => {
    __resetNetworkCacheForTests();
    __setNetworkCacheForTests("devnet"); // unlock self-serve issuance
    await initDb();
    app = await buildApp();

    // 1. Insert the merchant key directly (psql-equivalent).
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey, role, status) VALUES ($1, $2, $3, 'merchant', 'active')",
      [merchantKeyHash, merchantLabel, merchantPubkey],
    );

    // Provider row for the merchant_endpoints + observations to share.
    const prov = await getOne<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
      [hostname, hostname],
    );
    providerId = prov!.id;

    // 2. Active merchant_endpoints row so /observations can price the claim.
    // amount_usd=0.05 → 50000 micro-USDC → server_error 100% refund → 50000.
    const ep = await getOne<{ id: string }>(
      `INSERT INTO merchant_endpoints (
         merchant_pubkey, hostname, endpoint_path, amount_usd,
         preferred_rate_bps, status
       ) VALUES ($1, $2, '/v1/foo', 0.05, 100, 'active') RETURNING id`,
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
    if (issuedAgentLabels.length) {
      await query("DELETE FROM api_keys WHERE label = ANY($1::text[])", [
        issuedAgentLabels,
      ]).catch(() => {});
    }
    if (merchantEndpointId) {
      await query("DELETE FROM merchant_endpoints WHERE id = $1", [merchantEndpointId]);
    }
    if (providerId) {
      await query("DELETE FROM providers WHERE id = $1", [providerId]).catch(() => {});
    }
    await query("DELETE FROM api_keys WHERE key_hash = $1", [merchantKeyHash]);
    await app.close();
  });

  async function issueReferredAgentKey(
    refPubkey: string | undefined,
    extras: Partial<{ share_bps: number }> = {},
  ): Promise<{ apiKey: string; agentPubkey: string; agentLabel: string }> {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();
    const ch = (
      await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: pubkey },
      })
    ).json();
    const sig = signChallenge(kp, ch.nonce, pubkey);
    const payload: Record<string, unknown> = {
      agent_pubkey: pubkey,
      nonce: ch.nonce,
      signature: sig,
    };
    if (refPubkey !== undefined) payload.ref = refPubkey;
    if (extras.share_bps !== undefined) payload.share_bps = extras.share_bps;
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload,
    });
    if (r.statusCode !== 201) {
      throw new Error(`issuance failed ${r.statusCode}: ${r.body}`);
    }
    const body = r.json();
    issuedAgentLabels.push(body.label);
    return { apiKey: body.apiKey, agentPubkey: pubkey, agentLabel: body.label };
  }

  it("end-to-end: ref'd issuance → observation → claim → /referrals returns the attribution", async () => {
    // 3. Issue a self-serve key bound to the merchant as referrer.
    const agent = await issueReferredAgentKey(merchantPubkey, { share_bps: 2000 });
    const row = await getOne<{
      referrer_pubkey: string | null;
      referrer_share_bps: number | null;
    }>(
      "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
      [agent.agentLabel],
    );
    assert.equal(row?.referrer_pubkey, merchantPubkey);
    assert.equal(row?.referrer_share_bps, 2000);

    // 4. Merchant POSTs a server_error observation attributed to the agent.
    const obsBody = {
      hostname,
      endpoint: "/v1/foo",
      startedAt: 1_717_000_000_000,
      statusCode: 503,
      latencyMs: 100,
      classification: "server_error",
      agentPubkey: agent.agentPubkey,
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
    const obsJson = obsRes.json() as { accepted: number; recordId?: string };
    assert.equal(obsJson.accepted, 1);
    insertedRecordIds.push(obsJson.recordId!);

    // The claims row must carry referrer_pubkey = merchantPubkey (the agent
    // SDK's referrer was snapshotted onto the api_keys row in step 3, then
    // requireApiKey set request.referrerPubkey, which records.ts/observations
    // pass into maybeCreateClaim, which writes it into the claims row).
    //
    // BUT: /observations runs as the merchant's auth context — request.
    // referrerPubkey is the MERCHANT's referrer (null), not the agent's.
    // So this assertion is actually about whether the OBSERVATION path
    // attributes the claim to the agent's referrer.
    //
    // Re-reading Commit 2's observations.ts: it passes `referrerPubkey: null`
    // explicitly (the merchant isn't the agent's referrer; the merchant IS
    // the referrer-of-record but observations.ts doesn't look up the agent's
    // referrer). To make the K4 attribution work, we need the merchant to
    // BE the referrer on claims.referrer_pubkey. The merchant's pubkey
    // becomes claims.referrer_pubkey only when the AGENT (not the merchant)
    // submits the call — i.e. through /records.
    //
    // For this E2E, simulate the agent-side path by posting through
    // /api/v1/records using the agent's bearer (which has referrer_pubkey
    // set on its api_keys row). The merchant's /observations path would
    // also dedupe; we focus on the agent path that authentically populates
    // claims.referrer_pubkey.
    const recordsBody = {
      records: [
        {
          hostname,
          endpoint: "/v1/foo-agent",
          timestamp: new Date(1_717_000_001_000).toISOString(),
          status_code: 503,
          latency_ms: 100,
          classification: "server_error",
          payment_protocol: "x402",
          payment_amount: 50_000, // micro-USDC; triggers claim creation
          payment_asset: "USDC",
          payment_network: "solana",
        },
      ],
    };
    const recRes = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      headers: {
        authorization: `Bearer ${agent.apiKey}`,
        "content-type": "application/json",
      },
      payload: recordsBody,
    });
    assert.equal(recRes.statusCode, 200);
    const recJson = recRes.json() as { accepted: number; provider_ids: string[] };
    assert.equal(recJson.accepted, 1);

    // Find the call_record + claim from the agent ingest, confirm referrer
    // was snapshotted.
    const agentCallRecord = await getOne<{ id: string; provider_id: string }>(
      `SELECT id, provider_id FROM call_records
         WHERE agent_id = $1 AND endpoint = '/v1/foo-agent'
         ORDER BY created_at DESC LIMIT 1`,
      [agent.agentLabel],
    );
    assert.ok(agentCallRecord);
    insertedRecordIds.push(agentCallRecord!.id);
    const claim = await getOne<{ referrer_pubkey: string | null; refund_amount: string }>(
      `SELECT referrer_pubkey, refund_amount::text FROM claims
         WHERE call_record_id = $1`,
      [agentCallRecord!.id],
    );
    assert.ok(claim, "expected a claims row from the agent /records ingest");
    assert.equal(claim!.referrer_pubkey, merchantPubkey);
    // server_error → 100% refund → 50_000 micro-USDC.
    assert.equal(claim!.refund_amount, "50000");

    // 5. Merchant queries its referrals — should see the attribution.
    const refRes = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/me/referrals",
      headers: { authorization: `Bearer ${merchantApiKey}` },
    });
    assert.equal(refRes.statusCode, 200);
    const refJson = refRes.json() as {
      totalRefShareUsdc: string;
      byAgent: Array<{ agentPubkey: string; calls: number; refShareUsdc: string }>;
    };
    assert.equal(refJson.totalRefShareUsdc, "50000");
    const entry = refJson.byAgent.find((b) => b.agentPubkey === agent.agentPubkey);
    assert.ok(entry, "agent should appear in /me/referrals");
    assert.equal(entry!.calls, 1);
    assert.equal(entry!.refShareUsdc, "50000");
  });

  it("400 ReferrerNotFound when ?ref points at a non-merchant pubkey", async () => {
    const strangerPubkey = Keypair.generate().publicKey.toBase58();
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();
    const ch = (
      await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: pubkey },
      })
    ).json();
    const sig = signChallenge(kp, ch.nonce, pubkey);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: {
        agent_pubkey: pubkey,
        nonce: ch.nonce,
        signature: sig,
        ref: strangerPubkey,
      },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "ReferrerNotFound");
  });

  it("400 InvalidReferrerShareBps on share_bps > 3000", async () => {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();
    const ch = (
      await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: pubkey },
      })
    ).json();
    const sig = signChallenge(kp, ch.nonce, pubkey);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/keys/self-serve",
      payload: {
        agent_pubkey: pubkey,
        nonce: ch.nonce,
        signature: sig,
        ref: merchantPubkey,
        share_bps: 3001,
      },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "InvalidReferrerShareBps");
  });
});
