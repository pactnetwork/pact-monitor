import type { FastifyInstance } from "fastify";
import { getMany } from "../db.js";

export async function claimsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      provider_id?: string;
      agent_id?: string;
      // Filter by the on-chain wallet pubkey of the agent that authored the
      // call_record. Resolves through call_records.agent_pubkey, NOT
      // claims.agent_id (which is a backend label). Documented in
      // docs/agent-quickstart.md; previously the param was accepted by
      // Fastify's loose querystring schema but completely ignored by the
      // handler — every query returned the global claim list, breaking the
      // documented "find my own claims" UX.
      agent_pubkey?: string;
      trigger_type?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/v1/claims", async (request) => {
    const limit = Math.min(parseInt(request.query.limit || "50", 10), 200);
    const offset = parseInt(request.query.offset || "0", 10);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (request.query.provider_id) {
      conditions.push(`c.provider_id = $${paramIndex++}`);
      params.push(request.query.provider_id);
    }
    if (request.query.agent_id) {
      conditions.push(`c.agent_id = $${paramIndex++}`);
      params.push(request.query.agent_id);
    }
    if (request.query.agent_pubkey) {
      // Reads agent_pubkey off the joined call_records row. The claims
      // table only stores the label-style agent_id; the wallet pubkey
      // lives on the source call_record.
      conditions.push(`cr.agent_pubkey = $${paramIndex++}`);
      params.push(request.query.agent_pubkey);
    }
    if (request.query.trigger_type) {
      conditions.push(`c.trigger_type = $${paramIndex++}`);
      params.push(request.query.trigger_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit);
    const limitParam = `$${paramIndex++}`;
    params.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const rows = await getMany<{
      id: string;
      call_record_id: string;
      provider_id: string;
      provider_name: string;
      agent_id: string | null;
      trigger_type: string;
      call_cost: string | null;
      refund_pct: string;
      refund_amount: string | null;
      status: string;
      created_at: string;
    }>(`
      SELECT
        c.id, c.call_record_id, c.provider_id, p.name AS provider_name,
        c.agent_id, c.trigger_type, c.call_cost::text, c.refund_pct::text,
        c.refund_amount::text, c.status, c.created_at
      FROM claims c
      JOIN providers p ON p.id = c.provider_id
      JOIN call_records cr ON cr.id = c.call_record_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, params);

    return rows.map((r) => ({
      id: r.id,
      call_record_id: r.call_record_id,
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      agent_id: r.agent_id,
      trigger_type: r.trigger_type,
      call_cost: r.call_cost ? parseInt(r.call_cost, 10) : null,
      refund_pct: parseInt(r.refund_pct, 10),
      refund_amount: r.refund_amount ? parseInt(r.refund_amount, 10) : null,
      status: r.status,
      created_at: r.created_at,
    }));
  });
}
