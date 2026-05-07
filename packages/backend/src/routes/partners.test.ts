// Integration tests for F1 — admin referrer registration + partners read
// endpoint. Exercises the full stack: schema ALTER TABLE columns, admin
// PATCH validation + atomic write, and the partners GET auth + totals +
// pagination shape.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { initDb, query, getOne, pool as pgPool } from "../db.js";
import { adminRoutes } from "./admin.js";
import { partnersRoutes } from "./partners.js";

async function buildApp() {
  const app = Fastify();
  await app.register(adminRoutes);
  await app.register(partnersRoutes);
  return app;
}

const ADMIN_TOKEN = `admin-test-${randomUUID()}`;
const REFERRER_PUBKEY = `RefPartnerTest111111111111111111111111111111`.slice(0, 44);
const BAD_REFERRER = `RefOther22222222222222222222222222222222222`.slice(0, 44);

const REF_API_KEY = `pact_${randomBytes(24).toString("hex")}`;
const REF_KEY_HASH = createHash("sha256").update(REF_API_KEY).digest("hex");
const REF_LABEL = `ref-partner-${randomUUID()}`;

const OUTSIDER_API_KEY = `pact_${randomBytes(24).toString("hex")}`;
const OUTSIDER_KEY_HASH = createHash("sha256").update(OUTSIDER_API_KEY).digest("hex");
const OUTSIDER_LABEL = `outsider-${randomUUID()}`;

describe("F1 referrer registration + partners read endpoint", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const previousAdminToken = process.env.ADMIN_TOKEN;

  before(async () => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    // Apply schema.sql so a stale dev DB (or fresh CI Postgres) gets the
    // post-Phase-3 ALTERs needed by the records ingest end-to-end test
    // (call_records.agent_pubkey, api_keys.referrer_pubkey, etc.). Idempotent.
    await initDb();
    app = await buildApp();

    // Seed: one key to become a referrer; one key that stays an outsider.
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
      [REF_KEY_HASH, REF_LABEL, "RefAgent1111111111111111111111111111111111"],
    );
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
      [OUTSIDER_KEY_HASH, OUTSIDER_LABEL, "OutsiderAgent111111111111111111111111111111"],
    );
  });

  after(async () => {
    await query("DELETE FROM claims WHERE referrer_pubkey = $1", [REFERRER_PUBKEY]);
    await query("DELETE FROM api_keys WHERE label IN ($1, $2)", [REF_LABEL, OUTSIDER_LABEL]);
    if (previousAdminToken === undefined) {
      delete process.env.ADMIN_TOKEN;
    } else {
      process.env.ADMIN_TOKEN = previousAdminToken;
    }
    await app.close();
    await pgPool.end();
  });

  describe("PATCH /api/v1/admin/api-keys/:label/referrer", () => {
    it("rejects requests without the admin token", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: { "content-type": "application/json" },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 500 },
      });
      assert.equal(res.statusCode, 401);
    });

    it("rejects out-of-range share_bps (>3000)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 3001 },
      });
      assert.equal(res.statusCode, 400);
      // Confirm the DB row was NOT partially written.
      const row = await getOne<{
        referrer_pubkey: string | null;
        referrer_share_bps: number | null;
      }>(
        "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
        [REF_LABEL],
      );
      assert.equal(row?.referrer_pubkey, null);
      assert.equal(row?.referrer_share_bps, null);
    });

    it("rejects share_bps=0 with a referrer_pubkey set (use clear instead)", async () => {
      // The on-chain Pinocchio Policy args reject (referrer_present=1,
      // share_bps=0) as InvalidRate. Mirror that at registration so an
      // integrator can't end up in a state that fails policy creation later.
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 0 },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /\[1, 3000\]/);
      // Row stayed empty.
      const row = await getOne<{
        referrer_pubkey: string | null;
        referrer_share_bps: number | null;
      }>(
        "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
        [REF_LABEL],
      );
      assert.equal(row?.referrer_pubkey, null);
      assert.equal(row?.referrer_share_bps, null);
    });

    it("rejects share_bps=1000 with bogus pubkey shape (length guard)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: "too-short", referrer_share_bps: 1000 },
      });
      assert.equal(res.statusCode, 400);
    });

    it("rejects half-set registration (pubkey without share)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: null },
      });
      assert.equal(res.statusCode, 400);
    });

    it("404 on unknown label", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/does-not-exist/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 500 },
      });
      assert.equal(res.statusCode, 404);
    });

    it("atomically writes both columns on valid input", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 1000 },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.label, REF_LABEL);
      assert.equal(body.referrer_pubkey, REFERRER_PUBKEY);
      assert.equal(body.referrer_share_bps, 1000);

      const row = await getOne<{
        referrer_pubkey: string | null;
        referrer_share_bps: number | null;
      }>(
        "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
        [REF_LABEL],
      );
      assert.equal(row?.referrer_pubkey, REFERRER_PUBKEY);
      assert.equal(row?.referrer_share_bps, 1000);
    });

    it("clears both columns with both=null", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: null, referrer_share_bps: null },
      });
      assert.equal(res.statusCode, 200);
      const row = await getOne<{
        referrer_pubkey: string | null;
        referrer_share_bps: number | null;
      }>(
        "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
        [REF_LABEL],
      );
      assert.equal(row?.referrer_pubkey, null);
      assert.equal(row?.referrer_share_bps, null);
    });
  });

  describe("GET /api/v1/partners/:referrer_pubkey/policies — auth", () => {
    before(async () => {
      // Register the referrer so the api key is bound.
      await query(
        "UPDATE api_keys SET referrer_pubkey = $1, referrer_share_bps = $2 WHERE label = $3",
        [REFERRER_PUBKEY, 1000, REF_LABEL],
      );
    });

    it("401 without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, "missing_auth");
    });

    it("401 with outsider API key (not registered as this referrer)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${OUTSIDER_API_KEY}` },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, "invalid_auth");
    });

    it("401 when referrer pubkey mismatch (registered for a different referrer)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${BAD_REFERRER}/policies`,
        headers: { authorization: `Bearer ${REF_API_KEY}` },
      });
      assert.equal(res.statusCode, 401);
    });

    it("200 with admin token", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
    });

    it("200 with matching-referrer API key", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${REF_API_KEY}` },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe("GET /api/v1/partners/:referrer_pubkey/policies — contract", () => {
    it("returns the documented shape with empty data today", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.schema_version, 1);
      assert.equal(body.referrer, REFERRER_PUBKEY);
      assert.ok(body.window.from);
      assert.ok(body.window.to);
      assert.deepEqual(body.totals, {
        policies_referred: 0,
        premium_usdc_total: "0.00",
        referrer_cut_usdc_total: "0.00",
        claims_paid_usdc: "0.00",
      });
      assert.equal(body.settlement, "on_chain");
      assert.deepEqual(body.policies, []);
      assert.equal(body.pagination.limit, 100);
      assert.equal(body.pagination.next_cursor, null);
    });

    it("reflects claims.referrer_pubkey in claims_paid_usdc once data exists", async () => {
      // Seed a claim with the referrer denormalized column populated. Need
      // a call_record + provider to satisfy FK. The claim's refund_amount
      // is 0.50 USDC = 500_000 raw.
      const provRow = await getOne<{ id: string }>(
        `INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id`,
        [`partners-prov-${randomUUID()}`, `partners-${randomUUID()}.example`],
      );
      const crRow = await getOne<{ id: string }>(
        `INSERT INTO call_records
           (provider_id, endpoint, timestamp, status_code, latency_ms, classification, agent_id)
           VALUES ($1, '/x', NOW(), 500, 100, 'server_error', 'partners-test-agent')
           RETURNING id`,
        [provRow!.id],
      );
      await query(
        `INSERT INTO claims
           (call_record_id, provider_id, agent_id, trigger_type, refund_pct, refund_amount, referrer_pubkey)
           VALUES ($1, $2, 'partners-test-agent', 'server_error', 100, 500000, $3)`,
        [crRow!.id, provRow!.id, REFERRER_PUBKEY],
      );

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.totals.claims_paid_usdc, "0.50");

      // Cleanup
      await query("DELETE FROM claims WHERE referrer_pubkey = $1 AND provider_id = $2", [
        REFERRER_PUBKEY,
        provRow!.id,
      ]);
      await query("DELETE FROM call_records WHERE id = $1", [crRow!.id]);
      await query("DELETE FROM providers WHERE id = $1", [provRow!.id]);
    });

    it("rejects junk referrer_pubkey with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/x/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "invalid_referrer_pubkey");
    });

    it("honors limit query param (capped at 500)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies?limit=9999`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().pagination.limit, 500);
    });

    it("rejects invalid cursor", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies?cursor=not-a-date`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "invalid_cursor");
    });

    it("rejects cursor in the future", async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies?cursor=${encodeURIComponent(future)}`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "invalid_cursor");
      assert.match(res.json().message, /must not be in the future/);
    });

    it("claims_paid_usdc is the WINDOW total, not the page total", async () => {
      // Seed 3 claims totalling 3.00 USDC (3 * 1_000_000 raw). Request
      // limit=1; the headline total must still report the full window
      // (3.00), not just the single returned row (1.00).
      const provRow = await getOne<{ id: string }>(
        `INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id`,
        [`partners-window-${randomUUID()}`, `partners-window-${randomUUID()}.example`],
      );
      const claimIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const cr = await getOne<{ id: string }>(
          `INSERT INTO call_records
             (provider_id, endpoint, timestamp, status_code, latency_ms, classification, agent_id)
             VALUES ($1, '/x', NOW() - ($2 || ' minutes')::interval, 500, 100, 'server_error', 'partners-window-test-agent')
             RETURNING id`,
          [provRow!.id, String(i)],
        );
        const c = await getOne<{ id: string }>(
          `INSERT INTO claims
             (call_record_id, provider_id, agent_id, trigger_type, refund_pct, refund_amount, referrer_pubkey)
             VALUES ($1, $2, 'partners-window-test-agent', 'server_error', 100, 1000000, $3)
             RETURNING id`,
          [cr!.id, provRow!.id, REFERRER_PUBKEY],
        );
        claimIds.push(c!.id);
      }

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies?limit=1`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      // Page is bounded by limit, but the headline total covers the window.
      assert.equal(body.pagination.limit, 1);
      assert.equal(body.totals.claims_paid_usdc, "3.00");

      // Cleanup
      await query("DELETE FROM claims WHERE id = ANY($1::uuid[])", [claimIds]);
      await query(
        "DELETE FROM call_records WHERE agent_id = $1 AND provider_id = $2",
        ["partners-window-test-agent", provRow!.id],
      );
      await query("DELETE FROM providers WHERE id = $1", [provRow!.id]);
    });
  });

  describe("end-to-end: records ingest writes claims.referrer_pubkey", () => {
    // Reviewer's High finding: registering a referrer on an API key was a
    // no-op for analytics because the records → claims path never carried
    // referrer_pubkey through. This test exercises the full chain:
    // PATCH the api_keys.referrer_pubkey, then POST a failure record using
    // that key, then assert the claims row picked up the referrer snapshot.

    it("populates claims.referrer_pubkey from the API key's registration", async () => {
      // Lazy-load records routes here so the harness wires up the
      // requireApiKey middleware.
      const { recordsRoutes } = await import("./records.js");
      const subApp = Fastify();
      await subApp.register(recordsRoutes);
      try {
        // 1. Make sure the referrer is registered on the test API key.
        await query(
          "UPDATE api_keys SET referrer_pubkey = $1, referrer_share_bps = $2 WHERE label = $3",
          [REFERRER_PUBKEY, 1000, REF_LABEL],
        );

        // 2. POST a failing record under that key. payment_amount must be
        //    > 0 so maybeCreateClaim actually inserts a claim.
        const provHostname = `partners-e2e-${randomUUID()}.example`;
        const res = await subApp.inject({
          method: "POST",
          url: "/api/v1/records",
          headers: {
            authorization: `Bearer ${REF_API_KEY}`,
            "content-type": "application/json",
          },
          payload: {
            records: [
              {
                hostname: provHostname,
                endpoint: "/v0/x",
                timestamp: new Date().toISOString(),
                status_code: 500,
                latency_ms: 100,
                classification: "server_error",
                payment_amount: 1_000_000,
              },
            ],
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.accepted, 1);

        // 3. The claim row should carry the referrer snapshot.
        const provRow = await getOne<{ id: string }>(
          "SELECT id FROM providers WHERE base_url = $1",
          [provHostname],
        );
        assert.ok(provRow, "provider row must exist after ingest");
        const claim = await getOne<{
          referrer_pubkey: string | null;
          status: string;
        }>(
          `SELECT referrer_pubkey, status
             FROM claims
             WHERE provider_id = $1 AND agent_id = $2
             ORDER BY created_at DESC LIMIT 1`,
          [provRow!.id, REF_LABEL],
        );
        assert.ok(claim, "claim row must exist after ingest");
        assert.equal(
          claim!.referrer_pubkey,
          REFERRER_PUBKEY,
          "claims.referrer_pubkey should be the api_keys.referrer_pubkey snapshot",
        );

        // 4. And the partners endpoint should now see the payout.
        const partnersRes = await app.inject({
          method: "GET",
          url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        assert.equal(partnersRes.statusCode, 200);
        // At least 1.00 USDC from this claim is in the window total.
        const totalUsdc = parseFloat(
          partnersRes.json().totals.claims_paid_usdc,
        );
        assert.ok(
          totalUsdc >= 1.0,
          `claims_paid_usdc should reflect the e2e claim, got ${partnersRes.json().totals.claims_paid_usdc}`,
        );

        // Cleanup
        await query(
          "DELETE FROM claims WHERE provider_id = $1 AND agent_id = $2",
          [provRow!.id, REF_LABEL],
        );
        await query(
          "DELETE FROM call_records WHERE provider_id = $1",
          [provRow!.id],
        );
        await query("DELETE FROM providers WHERE id = $1", [provRow!.id]);
      } finally {
        await subApp.close();
      }
    });
  });
});
