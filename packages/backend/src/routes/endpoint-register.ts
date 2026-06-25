/**
 * `POST /api/v1/endpoint/register` + `GET /api/v1/endpoint/register/:id`
 * (Commit 2 H3).
 *
 * Merchants submit hostname + per-path pricing. The backend persists each
 * row as `pending_review`; ops runs `register-endpoint-onchain` to actually
 * submit the on-chain `register_endpoint` instruction (which requires the
 * protocol authority keypair — deliberately kept OUT of the public API
 * process). The status-poll endpoint lets the SDK watch progress.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireApiKey, requireRole } from "../middleware/auth.js";
import { query, getOne } from "../db.js";
import { canonicalHostname } from "../utils/hostname.js";

interface RegisterEndpointEntry {
  path: string;
  amountUsd: number;
}

interface RegisterBody {
  hostname: string;
  category?: string;
  endpoints: RegisterEndpointEntry[];
  preferredRateBps?: number;
}

const DEFAULT_PREFERRED_RATE_BPS = 100; // 1% — matches spec sample.

export async function endpointRegisterRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Body: RegisterBody }>(
    "/api/v1/endpoint/register",
    { preHandler: [requireApiKey, requireRole("merchant")] },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "Body required" });
      }
      if (!body.hostname || typeof body.hostname !== "string") {
        return reply.code(400).send({ error: "hostname is required" });
      }
      if (!Array.isArray(body.endpoints) || body.endpoints.length === 0) {
        return reply
          .code(400)
          .send({ error: "endpoints must be a non-empty array" });
      }

      let canonicalHost: string;
      try {
        canonicalHost = canonicalHostname(body.hostname);
      } catch (err) {
        request.log.warn({ err, hostname: body.hostname }, "Invalid hostname");
        return reply.code(400).send({ error: "Invalid hostname" });
      }

      const preferredRateBps =
        typeof body.preferredRateBps === "number"
          ? body.preferredRateBps
          : DEFAULT_PREFERRED_RATE_BPS;
      if (preferredRateBps < 0 || preferredRateBps > 10_000) {
        return reply
          .code(400)
          .send({ error: "preferredRateBps must be between 0 and 10000" });
      }

      // Per-row validation BEFORE any INSERT so the body is all-or-nothing.
      for (let i = 0; i < body.endpoints.length; i++) {
        const e = body.endpoints[i];
        if (!e || typeof e.path !== "string" || e.path.length === 0) {
          return reply.code(400).send({
            error: `endpoints[${i}].path must be a non-empty string`,
          });
        }
        if (typeof e.amountUsd !== "number" || !(e.amountUsd > 0)) {
          return reply.code(400).send({
            error: `endpoints[${i}].amountUsd must be a positive number`,
          });
        }
      }

      const merchantAuthed = request as FastifyRequest & {
        agentPubkey: string | null;
      };
      const merchantPubkey = merchantAuthed.agentPubkey;
      if (!merchantPubkey) {
        // Merchant key with no pubkey binding can't be attributed on-chain
        // and can't sign anything; fail loud instead of writing an orphan row.
        return reply.code(400).send({
          error:
            "merchant API key has no agent_pubkey binding; rebind via ops before registering endpoints",
        });
      }

      const registrations: Array<{
        id: string;
        path: string;
        status: string;
      }> = [];
      for (const e of body.endpoints) {
        const row = await getOne<{ id: string; status: string }>(
          `INSERT INTO merchant_endpoints (
             merchant_pubkey, hostname, endpoint_path, category, amount_usd,
             preferred_rate_bps
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (merchant_pubkey, hostname, endpoint_path)
             DO UPDATE SET
               amount_usd = EXCLUDED.amount_usd,
               preferred_rate_bps = EXCLUDED.preferred_rate_bps,
               category = COALESCE(EXCLUDED.category, merchant_endpoints.category)
           RETURNING id, status`,
          [
            merchantPubkey,
            canonicalHost,
            e.path,
            body.category ?? null,
            e.amountUsd,
            preferredRateBps,
          ],
        );
        registrations.push({
          id: row!.id,
          path: e.path,
          status: row!.status,
        });
      }

      return reply.code(200).send({
        registrations,
        etaHours: 24,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/endpoint/register/:id",
    { preHandler: [requireApiKey, requireRole("merchant")] },
    async (request, reply) => {
      const row = await getOne<{
        id: string;
        merchant_pubkey: string;
        hostname: string;
        endpoint_path: string;
        status: string;
        slug: string | null;
        on_chain_tx: string | null;
        updated_at: Date;
      }>(
        `SELECT id, merchant_pubkey, hostname, endpoint_path, status, slug,
                on_chain_tx, updated_at
           FROM merchant_endpoints WHERE id = $1`,
        [request.params.id],
      );
      if (!row) {
        return reply.code(404).send({ error: "Registration not found" });
      }
      const merchantAuthed = request as FastifyRequest & {
        agentPubkey: string | null;
      };
      // Auth-bind: a merchant can only read its own registrations.
      if (row.merchant_pubkey !== merchantAuthed.agentPubkey) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      return {
        id: row.id,
        hostname: row.hostname,
        endpointPath: row.endpoint_path,
        status: row.status,
        slug: row.slug,
        onChainTx: row.on_chain_tx,
        updatedAt: row.updated_at.toISOString(),
      };
    },
  );
}
