// Wire shapes pushed from the settler.
//
// `WrapCallEventDto` mirrors @pact-network/wrap's SettlementEvent (per-call
// outcome, camelCase, bigint-as-decimal-string). The indexer is responsible
// for projecting `outcome` into the legacy `breach` + `breachReason` columns
// expected by the Call table:
//
//   outcome              -> breach  | breachReason
//   "ok"                 -> false   | null
//   "latency_breach"     -> true    | "latency_breach"
//   "server_error"       -> true    | "server_error"
//   "network_error"      -> true    | "network_error"       (covered SLA breach)
//   "client_error"       -> false   | "client_error"        (not covered)
//
// On-chain semantics — `latency_breach`, `server_error`, and `network_error`
// all produce a covered refund (wrap classifier sets premium=flat,
// refund=imputed; the on-chain program debits the pool). The indexer must
// record breach=true for all three so PoolState reconciles with
// CoveragePool.current_balance. `client_error` is the only non-`ok` outcome
// not covered: the wrap classifier sets premium=0 and the settler drops it
// at the batcher (B2). If a `client_error` event still reaches the indexer
// (misclassification + non-zero premium), record breach=false honestly.

export type SettlementOutcome =
  | "ok"
  | "latency_breach"
  | "server_error"
  | "client_error"
  | "network_error";

export interface RecipientShareDto {
  /** FeeRecipientKind: 0=Treasury, 1=AffiliateAta, 2=AffiliatePda. */
  kind: number;
  /** ATA / vault pubkey credited on-chain (never a logical owner). */
  pubkey: string;
  /** bigint as decimal string. */
  amountLamports: string;
}

export interface WrapCallEventDto {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  /** bigint as decimal string, e.g. "1000". */
  premiumLamports: string;
  /** bigint as decimal string. */
  refundLamports: string;
  latencyMs: number;
  outcome: SettlementOutcome;
  source?: string;
  ts: string;
  settledAt: string;
  signature: string;
  /**
   * Per-call fee fan-out. Exactly mirrors the on-chain `settle_batch` fee
   * fan-out for THIS event: one entry per EndpointConfig.fee_recipients[i]
   * actually credited, with the rounded-down `premium * bps / 10_000`
   * amountLamports the program transferred.
   *
   * Contract with the settler: per-call shares are the source of truth; the
   * indexer aggregates them across the batch into RecipientEarnings.
   *
   * REQUIRED, possibly empty array. Never absent. A no-fee call (e.g. fully
   * refunded) MUST emit `[]`, not omit the field. The indexer 400s on missing
   * `shares` to surface contract drift loudly rather than silently zeroing
   * out fee attribution.
   */
  shares: RecipientShareDto[];
}

export interface SettlementEventDto {
  signature: string;
  batchSize: number;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  ts: string;
  calls: WrapCallEventDto[];
}

/**
 * Project an outcome into the (breach, breachReason) pair stored on Call.
 * Exported for unit testing and for use by services that ingest legacy
 * shapes. `latency_breach`, `server_error`, and `network_error` are all
 * covered SLA breaches that debit the on-chain pool — the indexer must
 * record breach=true for all three so PoolState reconciles with
 * CoveragePool.current_balance. Only `client_error` is non-covered.
 */
export function outcomeToBreach(
  outcome: SettlementOutcome,
): { breach: boolean; breachReason: string | null } {
  switch (outcome) {
    case "ok":
      return { breach: false, breachReason: null };
    case "latency_breach":
      return { breach: true, breachReason: "latency_breach" };
    case "server_error":
      return { breach: true, breachReason: "server_error" };
    case "client_error":
      // Caller-side errors (4xx, balance check fail). Wrap classifier sets
      // premium=0, settler drops at batcher (B2). If we see this here it
      // means the agent was charged anyway — record as non-breach for
      // honesty (the row tells the truth about misclassification).
      return { breach: false, breachReason: "client_error" };
    case "network_error":
      // Server unreachable / no response. Wrap classifier treats as covered
      // breach (premium=flat, refund=imputed). On-chain debits the pool. We
      // must record breach=true so PoolState reconciles with CoveragePool.
      return { breach: true, breachReason: "network_error" };
  }
}
