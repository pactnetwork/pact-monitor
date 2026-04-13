import { query, getOne } from "../db.js";
import {
  submitClaimOnChain,
  hasActiveOnChainPolicy,
  type CallRecord,
} from "../services/claim-settlement.js";

const REFUND_PCT: Record<string, number> = {
  timeout: 100,
  error: 100,
  schema_mismatch: 75,
  latency_sla: 50,
};

interface MinimalLogger {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

interface ClaimInput {
  callRecordId: string;
  providerId: string;
  agentId: string | null;
  classification: string;
  paymentAmount: number | null;
  // Optional Phase 3 fields — when provided, we attempt an on-chain
  // settlement in addition to the DB claim row. The SDK/records route will
  // start populating these once Phase 3 lands end-to-end.
  agentPubkey?: string | null;
  providerHostname?: string | null;
  latencyMs?: number | null;
  statusCode?: number | null;
  createdAt?: Date | null;
  logger?: MinimalLogger;
}

export async function maybeCreateClaim(input: ClaimInput): Promise<string | null> {
  const { callRecordId, providerId, agentId, classification, paymentAmount } = input;

  if (classification === "success") return null;
  if (!paymentAmount || paymentAmount <= 0) return null;

  const triggerType = classification;
  const refundPct = REFUND_PCT[triggerType];
  if (refundPct === undefined) return null;

  const refundAmount = Math.round((paymentAmount * refundPct) / 100);

  const row = await getOne<{ id: string }>(
    `INSERT INTO claims (
      call_record_id, provider_id, agent_id, trigger_type,
      call_cost, refund_pct, refund_amount, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'simulated')
    RETURNING id`,
    [callRecordId, providerId, agentId, triggerType, paymentAmount, refundPct, refundAmount],
  );

  const claimRowId = row?.id ?? null;

  // Non-blocking on-chain settlement attempt. Gated on agentPubkey +
  // providerHostname being provided by the caller — until the Phase 3 SDK
  // pivot lands, records.ts does not populate these and this branch is a
  // no-op.
  if (
    claimRowId &&
    input.agentPubkey &&
    input.providerHostname &&
    triggerType !== "success"
  ) {
    try {
      const hasPolicy = await hasActiveOnChainPolicy(
        input.agentPubkey,
        input.providerHostname,
      );
      if (hasPolicy) {
        const callRecord: CallRecord = {
          id: callRecordId,
          agent_id: agentId ?? "",
          agent_pubkey: input.agentPubkey,
          api_provider: input.providerHostname,
          payment_amount: paymentAmount,
          latency_ms: input.latencyMs ?? 0,
          status_code: input.statusCode ?? 0,
          classification: classification as CallRecord["classification"],
          created_at: input.createdAt ?? new Date(),
        };
        const result = await submitClaimOnChain(callRecord, input.providerHostname);
        await query(
          `UPDATE claims
           SET tx_hash = $1,
               settlement_slot = $2,
               status = 'settled',
               policy_id = $3
           WHERE id = $4`,
          [result.signature, result.slot, result.claimPda, claimRowId],
        );
      }
    } catch (err) {
      // Log but don't fail — DB claim row stays at status='simulated' so
      // it can be retried via POST /api/v1/claims/submit.
      input.logger?.warn(
        { err, callRecordId },
        "On-chain claim submission failed; claim remains simulated",
      );
    }
  }

  return claimRowId;
}
