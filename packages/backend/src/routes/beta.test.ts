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
  // Tally signs `JSON.stringify(payload)` with HMAC-SHA256 and sends the
  // signature base64-encoded in `tally-signature`. Match that exactly.
  return createHmac("sha256", secret).update(body).digest("base64");
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
      // Labels mirror the published form at tally.so/r/9qRXzQ exactly so
      // a regex regression in FIELD_MAP fails this test.
      const body = JSON.stringify({
        eventType: "FORM_RESPONSE",
        data: {
          submissionId,
          fields: [
            { key: "what_are_you_building", label: "What are you building?", value: "agent for x402 ops" },
            { key: "how_can_we_call_you", label: "How can we call you?", value: "Cipher" },
            { key: "email", label: "Email", value: "founder@example.com" },
            { key: "solana_address", label: "Solana Address", value: "DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc" },
            { key: "x_handle", label: "Project/Personal X Handle (Link)", value: "https://x.com/cipheragent" },
            { key: "telegram_handle", label: "Telegram Handle (handle)", value: "@cipheragent" },
            { key: "which_of_these_are_you", label: "Which of these are you?", value: "AI Agent" },
            {
              key: "apis_currently_paying",
              label: "Which APIs does your agent currently pay for?",
              value: "Helius, Birdeye",
            },
            {
              key: "why_pact",
              label: "Why are you considering trying out Pact Network?",
              value: "automatic refunds when an upstream 5xxes mid-agent-call",
            },
            {
              key: "willing_to_feedback",
              label: "Would you be willing to provide feedback after use? We will give special offers to early testers.",
              value: true,
            },
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
        display_name: string;
        email: string;
        wallet_pubkey: string;
        x_handle: string;
        telegram_handle: string;
        persona: string;
        apis_currently_paying: string;
        why_pact: string;
        willing_to_feedback: string;
        status: string;
      }>(
        `SELECT what_building, display_name, email, wallet_pubkey, x_handle,
                telegram_handle, persona, apis_currently_paying, why_pact,
                willing_to_feedback, status
           FROM beta_applicants WHERE id = $1`,
        [json.id],
      );
      assert.ok(row);
      assert.equal(row.what_building, "agent for x402 ops");
      assert.equal(row.display_name, "Cipher");
      assert.equal(row.email, "founder@example.com");
      assert.equal(row.wallet_pubkey, "DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc");
      assert.equal(row.x_handle, "https://x.com/cipheragent");
      assert.equal(row.telegram_handle, "@cipheragent");
      assert.equal(row.persona, "AI Agent");
      assert.equal(row.apis_currently_paying, "Helius, Birdeye");
      assert.equal(
        row.why_pact,
        "automatic refunds when an upstream 5xxes mid-agent-call",
      );
      assert.equal(row.willing_to_feedback, "true");
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

  // Regression test: betaRoutes installs a `parseAs: "buffer"` parser for
  // application/json. Fastify encapsulation should keep that parser scoped
  // to the betaRoutes plugin instance — even if a future caller registers
  // adminRoutes AFTER betaRoutes, the admin handlers must still receive a
  // parsed JSON object on their bodies, not a raw Buffer. If anyone ever
  // wraps betaRoutes in `fastify-plugin`, this test will fail because the
  // buffer parser will leak to admin's context.
  describe("content-type parser encapsulation", () => {
    it("does not leak Buffer-body parsing to admin routes registered later", async () => {
      const scoped = Fastify();
      // Reverse the order from the production app so this test specifically
      // exercises the "betaRoutes registered first, admin registered after"
      // case the reviewer flagged.
      await scoped.register(betaRoutes);
      await scoped.register(adminRoutes);
      try {
        const res = await scoped.inject({
          method: "POST",
          url: "/api/v1/admin/beta/gate",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          payload: { enabled: true },
        });
        // If the buffer parser had leaked into admin's context, the route
        // handler would have seen `request.body` as a Buffer, the
        // `typeof body.enabled !== "boolean"` guard would have fired, and
        // we'd see a 400. A 200 here proves admin still gets parsed JSON.
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), { enabled: true });
      } finally {
        await scoped.close();
      }
    });
  });
});
