// Integration tests for the private beta gate — covers the Tally webhook
// receiver (HMAC, idempotency, Telegram failure tolerance) and the admin
// approve + gate-toggle endpoints. Uses real Postgres via initDb() to
// match the rest of the suite.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { initDb, query, getOne, pool as pgPool } from "../db.js";
import { adminRoutes } from "./admin.js";
import { betaRoutes } from "./beta.js";

async function buildApp() {
  const app = Fastify();
  await app.register(adminRoutes);
  await app.register(betaRoutes);
  return app;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const ADMIN_TOKEN = `admin-beta-test-${randomUUID()}`;
const TALLY_SECRET = `tally-test-${randomUUID()}`;

describe("private beta gate", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const previousAdminToken = process.env.ADMIN_TOKEN;
  const previousTallySecret = process.env.TALLY_WEBHOOK_SECRET;
  const createdSubmissionIds: string[] = [];
  const createdApplicantIds: string[] = [];

  before(async () => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.TALLY_WEBHOOK_SECRET = TALLY_SECRET;
    // No Telegram env on purpose — confirms the route does not 500 when
    // notifyTelegram has nothing to do.
    delete process.env.BETA_TELEGRAM_BOT_TOKEN;
    delete process.env.BETA_TELEGRAM_CHAT_ID;
    await initDb();
    app = await buildApp();
  });

  after(async () => {
    if (createdApplicantIds.length > 0) {
      await query(
        "DELETE FROM api_keys WHERE beta_applicant_id = ANY($1::uuid[])",
        [createdApplicantIds],
      );
      await query("DELETE FROM beta_applicants WHERE id = ANY($1::uuid[])", [
        createdApplicantIds,
      ]);
    }
    if (createdSubmissionIds.length > 0) {
      await query("DELETE FROM beta_applicants WHERE tally_submission_id = ANY($1)", [
        createdSubmissionIds,
      ]);
    }
    await query("DELETE FROM system_flags WHERE key = 'beta_gate_enabled'");

    process.env.ADMIN_TOKEN = previousAdminToken;
    process.env.TALLY_WEBHOOK_SECRET = previousTallySecret;
    await app.close();
    await pgPool.end();
  });

  describe("POST /api/v1/beta/apply", () => {
    it("rejects requests without a valid HMAC", async () => {
      const submissionId = `tally_bad_${randomUUID()}`;
      const body = JSON.stringify({
        eventType: "FORM_RESPONSE",
        data: { submissionId, fields: [] },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/beta/apply",
        headers: {
          "content-type": "application/json",
          "tally-signature": "00".repeat(32),
        },
        payload: body,
      });
      assert.equal(res.statusCode, 401);
    });

    it("accepts a well-signed submission and persists fields", async () => {
      const submissionId = `tally_ok_${randomUUID()}`;
      createdSubmissionIds.push(submissionId);
      const body = JSON.stringify({
        eventType: "FORM_RESPONSE",
        data: {
          submissionId,
          fields: [
            { key: "what_are_you_building", label: "What are you building?", value: "agent for x402 ops" },
            { key: "urgency", label: "When would you integrate?", value: "this week" },
            { key: "email", label: "Email", value: "founder@example.com" },
          ],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/beta/apply",
        headers: {
          "content-type": "application/json",
          "tally-signature": sign(body, TALLY_SECRET),
        },
        payload: body,
      });
      assert.equal(res.statusCode, 201);
      const json = res.json() as { id: string; status: string };
      assert.equal(json.status, "received");
      createdApplicantIds.push(json.id);

      const row = await getOne<{
        what_building: string;
        urgency: string;
        email: string;
        status: string;
      }>(
        "SELECT what_building, urgency, email, status FROM beta_applicants WHERE id = $1",
        [json.id],
      );
      assert.ok(row);
      assert.equal(row.what_building, "agent for x402 ops");
      assert.equal(row.urgency, "this week");
      assert.equal(row.email, "founder@example.com");
      assert.equal(row.status, "pending");
    });

    it("is idempotent on duplicate submissionId", async () => {
      const submissionId = `tally_dup_${randomUUID()}`;
      createdSubmissionIds.push(submissionId);
      const body = JSON.stringify({
        eventType: "FORM_RESPONSE",
        data: {
          submissionId,
          fields: [{ key: "what_are_you_building", value: "duplicate-test" }],
        },
      });
      const headers = {
        "content-type": "application/json",
        "tally-signature": sign(body, TALLY_SECRET),
      };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/beta/apply",
        headers,
        payload: body,
      });
      assert.equal(first.statusCode, 201);
      const firstJson = first.json() as { id: string };
      createdApplicantIds.push(firstJson.id);

      const second = await app.inject({
        method: "POST",
        url: "/api/v1/beta/apply",
        headers,
        payload: body,
      });
      assert.equal(second.statusCode, 200);
      const secondJson = second.json() as { id: string; status: string };
      assert.equal(secondJson.id, firstJson.id);
      assert.equal(secondJson.status, "duplicate");
    });

    it("returns 503 when secret is missing", async () => {
      const saved = process.env.TALLY_WEBHOOK_SECRET;
      delete process.env.TALLY_WEBHOOK_SECRET;
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/beta/apply",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ data: { submissionId: "x", fields: [] } }),
        });
        assert.equal(res.statusCode, 503);
      } finally {
        process.env.TALLY_WEBHOOK_SECRET = saved;
      }
    });
  });

  describe("POST /api/v1/admin/beta/approve", () => {
    it("rejects requests without the admin token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/approve",
        headers: { "content-type": "application/json" },
        payload: { applicantId: randomUUID() },
      });
      assert.equal(res.statusCode, 401);
    });

    it("returns 404 for an unknown applicant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/approve",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { applicantId: randomUUID() },
      });
      assert.equal(res.statusCode, 404);
    });

    it("mints a key whose hash matches the stored row and flips status", async () => {
      const id = randomUUID();
      createdApplicantIds.push(id);
      await query(
        `INSERT INTO beta_applicants (id, email, what_building) VALUES ($1, $2, $3)`,
        [id, "approve@example.com", "approve-flow"],
      );

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/approve",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { applicantId: id, note: "ack" },
      });
      assert.equal(res.statusCode, 201);
      const json = res.json() as { apiKey: string; applicantId: string; keyId: string };
      assert.ok(json.apiKey.startsWith("pact_beta_"));
      assert.equal(json.applicantId, id);

      const expectedHash = createHash("sha256").update(json.apiKey).digest("hex");
      const key = await getOne<{ key_hash: string; status: string; beta_applicant_id: string }>(
        "SELECT key_hash, status, beta_applicant_id FROM api_keys WHERE id = $1",
        [json.keyId],
      );
      assert.ok(key);
      assert.equal(key.key_hash, expectedHash);
      assert.equal(key.status, "active");
      assert.equal(key.beta_applicant_id, id);

      const applicant = await getOne<{ status: string; note: string }>(
        "SELECT status, note FROM beta_applicants WHERE id = $1",
        [id],
      );
      assert.equal(applicant?.status, "approved");
      assert.equal(applicant?.note, "ack");
    });

    it("rejects double-approval with 409", async () => {
      const id = randomUUID();
      createdApplicantIds.push(id);
      await query(
        `INSERT INTO beta_applicants (id, status, what_building) VALUES ($1, 'approved', 'already-approved')`,
        [id],
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/approve",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { applicantId: id },
      });
      assert.equal(res.statusCode, 409);
    });
  });

  describe("POST /api/v1/admin/beta/gate", () => {
    it("rejects requests without the admin token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/gate",
        headers: { "content-type": "application/json" },
        payload: { enabled: true },
      });
      assert.equal(res.statusCode, 401);
    });

    it("rejects a non-boolean enabled value", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/gate",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { enabled: "yes" },
      });
      assert.equal(res.statusCode, 400);
    });

    it("inserts then updates the system_flags row", async () => {
      await query("DELETE FROM system_flags WHERE key = 'beta_gate_enabled'");
      const on = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/gate",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { enabled: true },
      });
      assert.equal(on.statusCode, 200);
      assert.deepEqual(on.json(), { enabled: true });

      const off = await app.inject({
        method: "POST",
        url: "/api/v1/admin/beta/gate",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { enabled: false },
      });
      assert.equal(off.statusCode, 200);
      const row = await getOne<{ enabled: boolean }>(
        "SELECT enabled FROM system_flags WHERE key = 'beta_gate_enabled'",
      );
      assert.equal(row?.enabled, false);
    });
  });
});
