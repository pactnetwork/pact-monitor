/**
 * `POST /api/v1/observations` — merchant-side single-record ingest (Commit 1
 * stub layer of the Merchant SDK).
 *
 * Auth chain: requireApiKey (sets request.agentPubkey + request.role from
 * api_keys), requireRole('merchant') (rejects non-merchant keys with 403),
 * verifyObservationSignature (Ed25519 over canonical JSON of the body when
 * the X-Pact-Signature header is present; grace-period is shared with
 * /records via REQUIRE_RECORD_SIGNATURES).
 *
 * Persistence reuses the existing call_records partial-unique index on
 * (agent_pubkey, timestamp, endpoint) WHERE agent_pubkey IS NOT NULL. Two
 * key invariants:
 *  - When agentPubkey is present, startedAt is REQUIRED (409 otherwise) so
 *    the dedupe key matches an agent's own /records ingest of the same call.
 *  - ON CONFLICT DO NOTHING returns 0 rows on duplicate; we surface that as
 *    { accepted: 0 } so the merchant SDK observe() shape matches Commit 2.
 *
 * `maybeCreateClaim` is intentionally NOT called from this route in Commit
 * 1 — the per-merchant claim pipeline needs the merchant_endpoints + ops
 * registration tables that land in Commit 2.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireApiKey,
  requireRole,
  verifyObservationSignature,
} from "../middleware/auth.js";
import { query } from "../db.js";
import { canonicalHostname } from "../utils/hostname.js";
import { findOrCreateProvider } from "../utils/providers.js";

const VALID_CLASSIFICATIONS = [
  "success",
  "timeout",
  "client_error",
  "server_error",
  "schema_mismatch",
] as const;
type Classification = (typeof VALID_CLASSIFICATIONS)[number];

interface ObservationBody {
  agentPubkey?: string | null;
  hostname: string;
  endpoint: string;
  startedAt?: number;
  statusCode: number;
  latencyMs: number;
  classification: Classification;
  paymentHeaders?: Record<string, string>;
}

export async function observationsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ObservationBody }>(
    "/api/v1/observations",
    {
      preHandler: [requireApiKey, requireRole("merchant"), verifyObservationSignature],
    },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "Observation body required" });
      }

      if (!VALID_CLASSIFICATIONS.includes(body.classification)) {
        return reply.code(400).send({
          error: `Invalid classification: ${JSON.stringify(body.classification)}. Allowed: ${VALID_CLASSIFICATIONS.join(", ")}`,
          field: "classification",
        });
      }
      if (!body.endpoint || typeof body.endpoint !== "string") {
        return reply.code(400).send({ error: "endpoint is required" });
      }
      if (!body.hostname || typeof body.hostname !== "string") {
        return reply.code(400).send({ error: "hostname is required" });
      }
      if (typeof body.statusCode !== "number" || typeof body.latencyMs !== "number") {
        return reply.code(400).send({
          error: "statusCode and latencyMs (number) are required",
        });
      }

      const agentPubkey = body.agentPubkey ?? null;

      // 409 when the dedupe key cannot be constructed — agent context with
      // no startedAt would race against an agent self-ingest of the same
      // call, defeating idempotency.
      if (agentPubkey && !body.startedAt) {
        return reply.code(409).send({
          error: "StartedAtRequired",
          message:
            "startedAt is required when agentPubkey is present so the dedupe key matches agent /records ingest",
        });
      }

      let canonicalHost: string;
      try {
        canonicalHost = canonicalHostname(body.hostname);
      } catch (err) {
        request.log.warn(
          { err, hostname: body.hostname },
          "Rejecting observation with invalid hostname",
        );
        return reply.code(400).send({ error: "Invalid hostname" });
      }

      const providerId = await findOrCreateProvider(canonicalHost);

      const merchantAuthed = request as FastifyRequest & {
        agentId: string;
        agentPubkey: string | null;
      };
      // The merchant's pubkey on this route IS the api_keys.agent_pubkey
      // bound to the role='merchant' row (validated by
      // verifyObservationSignature).
      const merchantPubkey = merchantAuthed.agentPubkey;
      const ts = new Date(body.startedAt ?? Date.now());

      const result = await query<{ id: string }>(
        `INSERT INTO call_records (
           provider_id, endpoint, timestamp, status_code, latency_ms,
           classification, agent_id, agent_pubkey, merchant_pubkey, origin
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'merchant')
         ON CONFLICT (agent_pubkey, timestamp, endpoint)
           WHERE agent_pubkey IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          providerId,
          body.endpoint,
          ts,
          body.statusCode,
          body.latencyMs,
          body.classification,
          merchantAuthed.agentId,
          agentPubkey,
          merchantPubkey,
        ],
      );

      if (result.rows.length === 0) {
        return reply.code(200).send({ accepted: 0 });
      }
      return reply.code(200).send({
        accepted: 1,
        recordId: result.rows[0].id,
      });
    },
  );
}
