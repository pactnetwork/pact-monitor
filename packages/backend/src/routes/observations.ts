/**
 * `POST /api/v1/observations` — merchant-side single-record ingest.
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
 *    { accepted: 0 } so the merchant SDK observe() shape matches.
 *
 * Commit 2 wires `maybeCreateClaim` after a successful INSERT. The price
 * fed to the claim is sourced from the registered merchant_endpoints row
 * (status='active') matching (merchant_pubkey, hostname, endpoint_path) —
 * passing paymentAmount=null would early-exit at claims.ts:52, so the
 * lookup is mandatory for any claim to flow through.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireApiKey,
  requireRole,
  verifyObservationSignature,
} from "../middleware/auth.js";
import { query, getOne } from "../db.js";
import { canonicalHostname } from "../utils/hostname.js";
import { findOrCreateProvider } from "../utils/providers.js";
import { maybeCreateClaim } from "../utils/claims.js";
import { defaultClassify } from "../utils/classifier.js";

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

      const merchantAuthedEarly = request as FastifyRequest & {
        agentPubkey: string | null;
      };
      const merchantPubkeyEarly = merchantAuthedEarly.agentPubkey;

      // PR #223 Section D: spec § POST /observations example omits
      // `hostname`. Non-Node clients following the spec would 400; derive
      // from the merchant's active registered endpoints when not supplied.
      let canonicalHost: string;
      if (body.hostname && typeof body.hostname === "string") {
        try {
          canonicalHost = canonicalHostname(body.hostname);
        } catch (err) {
          request.log.warn(
            { err, hostname: body.hostname },
            "Rejecting observation with invalid hostname",
          );
          return reply.code(400).send({ error: "Invalid hostname" });
        }
      } else {
        if (!merchantPubkeyEarly) {
          return reply.code(400).send({
            error: "HostnameRequired",
            message:
              "hostname missing and merchant API key has no agent_pubkey binding to look up registered endpoints",
          });
        }
        const matches = await query<{ hostname: string }>(
          `SELECT DISTINCT hostname FROM merchant_endpoints
             WHERE merchant_pubkey = $1
               AND endpoint_path = $2
               AND status = 'active'`,
          [merchantPubkeyEarly, body.endpoint],
        );
        if (matches.rowCount === 0) {
          return reply.code(400).send({
            error: "HostnameRequired",
            message:
              "hostname missing and no active registered endpoint matches endpoint_path; supply hostname in the body",
          });
        }
        if ((matches.rowCount ?? 0) > 1) {
          return reply.code(400).send({
            error: "HostnameAmbiguous",
            message: `merchant has ${matches.rowCount} active hostnames for endpoint_path ${body.endpoint}; supply hostname in the body to disambiguate`,
          });
        }
        canonicalHost = matches.rows[0].hostname; // already canonical from /endpoint/register
      }

      const providerId = await findOrCreateProvider(canonicalHost);

      const merchantAuthed = request as FastifyRequest & {
        agentId: string;
        agentPubkey: string | null;
      };
      // The merchant's pubkey on this route IS the api_keys.agent_pubkey
      // bound to the role='merchant' row (validated by
      // verifyObservationSignature). Same value as `merchantPubkeyEarly`
      // resolved above for the hostname-derivation block.
      const merchantPubkey = merchantAuthed.agentPubkey;
      const ts = new Date(body.startedAt ?? Date.now());

      // PR #223 review Section A: Pact's classifier is authoritative; the
      // merchant's body.classification is a hint we record divergence on
      // but never trust. Recompute from (statusCode, latencyMs) using the
      // same default-classifier the SDK + market-proxy use (locked by the
      // cross-package parity test in market-proxy/.../classifier-parity).
      const authoritativeClassification = defaultClassify({
        statusCode: body.statusCode,
        latencyMs: body.latencyMs,
      });
      if (body.classification !== authoritativeClassification) {
        request.log.warn(
          {
            merchantPubkey,
            endpoint: body.endpoint,
            statusCode: body.statusCode,
            latencyMs: body.latencyMs,
            hint: body.classification,
            authoritative: authoritativeClassification,
          },
          "Merchant classification diverged from authoritative",
        );
      }

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
          authoritativeClassification,
          merchantAuthed.agentId,
          agentPubkey,
          merchantPubkey,
        ],
      );

      if (result.rows.length === 0) {
        return reply.code(200).send({ accepted: 0 });
      }
      const callRecordId = result.rows[0].id;

      // Look up the priced merchant_endpoints row so maybeCreateClaim has a
      // real paymentAmount. Without this, claims.ts:52 short-circuits on
      // `!paymentAmount` and no claim is ever generated. If no active row
      // is found (endpoint not yet registered or status='pending_review'),
      // we still persist the observation but skip the claim path — same
      // graceful no-op as agent records without payment headers.
      const priced = await getOne<{ amount_usd: string }>(
        `SELECT amount_usd::text FROM merchant_endpoints
           WHERE merchant_pubkey = $1
             AND hostname = $2
             AND endpoint_path = $3
             AND status = 'active'
           LIMIT 1`,
        [merchantPubkey, canonicalHost, body.endpoint],
      );
      let paymentAmount: number | null = null;
      if (priced) {
        const usd = parseFloat(priced.amount_usd);
        if (Number.isFinite(usd) && usd > 0) {
          paymentAmount = Math.round(usd * 1_000_000); // micro-USDC
        }
      } else {
        request.log.warn(
          {
            merchantPubkey,
            hostname: canonicalHost,
            endpoint: body.endpoint,
          },
          "No active merchant_endpoints row for observation; claim path skipped",
        );
      }

      await maybeCreateClaim({
        callRecordId,
        providerId,
        agentId: merchantAuthed.agentId,
        // Use the AUTHORITATIVE classification (recomputed above) so a
        // merchant can't return 503 and pass classification:"success" to
        // suppress refund creation.
        classification: authoritativeClassification,
        paymentAmount,
        agentPubkey,
        referrerPubkey: null,
        providerHostname: canonicalHost,
        latencyMs: body.latencyMs,
        statusCode: body.statusCode,
        createdAt: ts,
        logger: app.log,
      });

      return reply.code(200).send({
        accepted: 1,
        recordId: callRecordId,
      });
    },
  );
}
