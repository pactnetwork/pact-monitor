import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  submitClaimOnChain,
  hasActiveOnChainPolicy,
  type CallRecord,
} from "../services/claim-settlement.js";
import { query } from "../db.js";
import { requireApiKey } from "../middleware/auth.js";
import { canonicalHostname } from "../utils/hostname.js";
import {
  GoldRushVerifier,
  createDefaultClient,
  type VerificationDetail,
} from "../services/goldrush-verifier.js";
import { recordGoldrushMetric } from "../services/goldrush-metrics.js";

interface CallRecordRow {
  id: string;
  agent_id: string;
  agent_pubkey: string | null;
  api_provider: string;
  payment_amount: number | null;
  latency_ms: number;
  status_code: number;
  classification: CallRecord["classification"];
  created_at: Date;
  // Additive in the SELECT — these were already on call_records but
  // claims-submit wasn't reading them. Without these we can't ask
  // GoldRush whether the upstream tx actually happened.
  tx_hash: string | null;
  recipient_address: string | null;
}

// Singleton verifier per process. Cheap to construct (just reads env), but
// allocating once also keeps the in-memory dedupe cache shared across
// requests. createDefaultClient() returns null when GOLDRUSH_API_KEY is
// unset, which downgrades verify() to a no-op "skipped" result — the
// integration is fully optional at runtime.
const goldrushVerifier = new GoldRushVerifier({
  client: createDefaultClient(),
  recordMetric: recordGoldrushMetric,
});

export async function claimsSubmitRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { callRecordId: string; providerHostname: string } }>(
    "/api/v1/claims/submit",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { callRecordId, providerHostname } = request.body ?? {};
      if (!callRecordId || !providerHostname) {
        return reply.code(400).send({
          error: "callRecordId and providerHostname are required",
        });
      }

      // The provider row's base_url is stored in canonical form (F2). SDK
      // clients may still send mixed-case, URL-with-path, or trailing-dot
      // FQDN form, so canonicalize the incoming value before the equality
      // check against api_provider.
      let canonicalProviderHostname: string;
      try {
        canonicalProviderHostname = canonicalHostname(providerHostname);
      } catch {
        return reply.code(400).send({ error: "Invalid providerHostname" });
      }

      const result = await query<CallRecordRow>(
        `SELECT cr.id,
                cr.agent_id,
                cr.agent_pubkey,
                p.base_url AS api_provider,
                cr.payment_amount,
                cr.latency_ms,
                cr.status_code,
                cr.classification,
                cr.created_at,
                cr.tx_hash,
                cr.recipient_address
         FROM call_records cr
         JOIN providers p ON p.id = cr.provider_id
         WHERE cr.id = $1`,
        [callRecordId],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "Call record not found" });
      }

      const row = result.rows[0];
      const authed = request as FastifyRequest & { agentId: string };
      if (authed.agentId !== row.agent_id) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (canonicalProviderHostname !== row.api_provider) {
        return reply.code(400).send({ error: "providerHostname does not match call record" });
      }
      if (!row.agent_pubkey) {
        return reply.code(400).send({ error: "Call record missing agent_pubkey" });
      }

      const hasPolicy = await hasActiveOnChainPolicy(row.agent_pubkey, canonicalProviderHostname);
      if (!hasPolicy) {
        return reply.code(404).send({
          error: "No active on-chain policy for this agent/provider",
        });
      }

      // ────────────────────────────────────────────────────────────────
      // GoldRush verification gate (additive, non-blocking).
      // ────────────────────────────────────────────────────────────────
      // The verifier always resolves, never throws. On any failure mode
      // — down, slow, rate-limited, stale, no API key configured — we
      // log it as `verification_unavailable` and continue with the
      // existing trust-the-agent + on-chain caps logic. This is the
      // brief's "golden rule extended": GoldRush MUST NOT block claims.
      //
      // The result is attached to the response and emitted as a
      // structured log line so Conv 2 has 14 days of telemetry, not a
      // single demo screenshot.
      let verification: VerificationDetail | null = null;
      try {
        verification = await goldrushVerifier.verify({
          txSignature: row.tx_hash,
          agentPubkey: row.agent_pubkey,
          recipientAddress: row.recipient_address,
          expectedAmount: row.payment_amount != null ? Number(row.payment_amount) : null,
          callTimestamp: row.created_at,
        });
        request.log.info(
          {
            event: "goldrush_verification",
            callRecordId,
            tx_sig: row.tx_hash,
            result: verification.result,
            confidence: verification.confidence,
            latency_ms: verification.latencyMs,
            cache_hit: verification.cacheHit,
          },
          "goldrush verification",
        );
      } catch (err) {
        // Belt-and-suspenders. GoldRushVerifier.verify() is documented to
        // never throw; if it does we still fall through to the existing
        // path. We do NOT short-circuit claim adjudication on this.
        request.log.warn({ err }, "GoldRush verifier unexpectedly threw; falling through");
      }

      const callRecord: CallRecord = {
        id: row.id,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
        api_provider: row.api_provider,
        payment_amount: Number(row.payment_amount ?? 0),
        latency_ms: row.latency_ms,
        status_code: row.status_code,
        classification: row.classification,
        created_at: row.created_at,
      };

      try {
        const settlement = await submitClaimOnChain(callRecord, canonicalProviderHostname);
        await query(
          `UPDATE claims
           SET tx_hash = $1,
               settlement_slot = $2,
               status = 'settled',
               policy_id = $3
           WHERE call_record_id = $4`,
          [settlement.signature, settlement.slot, settlement.claimPda, callRecordId],
        );
        return reply.send({
          signature: settlement.signature,
          slot: settlement.slot,
          refundAmount: settlement.refundAmount,
          // Additive in the response. Existing clients ignore unknown keys.
          // SDKs that want to surface "verified by GoldRush" to the agent
          // can read this; SDKs that don't, don't notice the change.
          verification: verification
            ? {
                result: verification.result,
                confidence: verification.confidence,
                reason: verification.reason,
              }
            : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, "Claim settlement failed");
        return reply.code(500).send({
          error: "Claim settlement failed",
          details: message,
        });
      }
    },
  );
}
