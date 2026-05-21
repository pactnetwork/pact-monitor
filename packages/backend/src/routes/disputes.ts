/**
 * `POST /api/v1/disputes` (Commit 2 H4).
 *
 * V1: persists an ops ticket. No on-chain reversal — ops resolves
 * out-of-band via direct DB writes + manual settler intervention. Optional
 * Slack notification on PACT_OPS_SLACK_WEBHOOK_URL (fire-and-forget; a
 * webhook outage never blocks the response).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireApiKey, requireRole } from "../middleware/auth.js";
import { query, getOne } from "../db.js";

interface DisputeBody {
  callRecordId: string;
  reason: string;
  evidence?: Record<string, unknown>;
}

function notifySlack(payload: {
  ticketId: string;
  merchantPubkey: string;
  callRecordId: string;
  reason: string;
}): void {
  const url = process.env.PACT_OPS_SLACK_WEBHOOK_URL;
  if (!url) return;
  const text =
    `Pact dispute opened: ticket ${payload.ticketId} by merchant ${payload.merchantPubkey} ` +
    `against call ${payload.callRecordId} — reason: ${payload.reason.slice(0, 200)}`;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {
    /* best-effort; ops still sees the row in dispute_tickets */
  });
}

export async function disputesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DisputeBody }>(
    "/api/v1/disputes",
    { preHandler: [requireApiKey, requireRole("merchant")] },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "Body required" });
      }
      if (!body.callRecordId || typeof body.callRecordId !== "string") {
        return reply.code(400).send({ error: "callRecordId is required" });
      }
      if (!body.reason || typeof body.reason !== "string") {
        return reply.code(400).send({ error: "reason is required" });
      }

      const merchantAuthed = request as FastifyRequest & {
        agentPubkey: string | null;
      };
      const merchantPubkey = merchantAuthed.agentPubkey;
      if (!merchantPubkey) {
        return reply.code(400).send({
          error: "merchant API key has no agent_pubkey binding",
        });
      }

      // Auth-bind: a merchant can only dispute calls attributed to them
      // (call_records.merchant_pubkey set by /api/v1/observations).
      const call = await getOne<{
        id: string;
        merchant_pubkey: string | null;
      }>(
        "SELECT id, merchant_pubkey FROM call_records WHERE id = $1",
        [body.callRecordId],
      );
      if (!call) {
        return reply.code(404).send({ error: "call_record not found" });
      }
      if (call.merchant_pubkey !== merchantPubkey) {
        return reply.code(403).send({
          error: "Forbidden: call_record is not attributed to this merchant",
        });
      }

      const row = await getOne<{ id: string; status: string }>(
        `INSERT INTO dispute_tickets (
           merchant_pubkey, call_record_id, reason, evidence
         ) VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, status`,
        [
          merchantPubkey,
          body.callRecordId,
          body.reason,
          JSON.stringify(body.evidence ?? {}),
        ],
      );

      notifySlack({
        ticketId: row!.id,
        merchantPubkey,
        callRecordId: body.callRecordId,
        reason: body.reason,
      });

      return reply.code(200).send({
        ticketId: row!.id,
        status: row!.status,
      });
    },
  );
}
