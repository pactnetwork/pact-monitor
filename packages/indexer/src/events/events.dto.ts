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
//   "client_error"       -> false   | "client_error"        (no payout owed)
//   "network_error"      -> false   | "network_error"       (no payout owed)
//
// Per layering plan §4: only `latency_breach` and `server_error` produce a
// covered refund; the others are recorded as misses but do not breach the
// pool. They are still surfaced via `breachReason` for the analytics path.

export type SettlementOutcome =
  | "ok"
  | "latency_breach"
  | "server_error"
  | "client_error"
  | "network_error";

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
}

export interface RecipientShareDto {
  /** FeeRecipientKind: 0=Treasury, 1=AffiliateAta, 2=AffiliatePda. */
  recipientKind: number;
  recipientPubkey: string;
  /** bigint as decimal string. */
  amountLamports: string;
}

export interface SettlementEventDto {
  signature: string;
  batchSize: number;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  /**
   * Top-level, batch-aggregate per-recipient fee breakdown.
   *
   * Contract with the settler (#62): `shares` lives at the SettlementEventDto
   * top level, NOT nested per-call inside `WrapCallEventDto`. The settler
   * aggregates fee outflows across the whole batch and emits one
   * RecipientShareDto per (kind, recipientPubkey) pair. The indexer
   * apportions those totals across endpoints proportional to gross premiums
   * within the batch (see TODO in events.service.ts about per-call splits).
   *
   * Empty/missing when the batch had no fee outflows (e.g. every call
   * refunded). Do NOT add a per-call `shares` field on WrapCallEventDto —
   * that would duplicate the contract and silently zero-out earnings if the
   * two emitters disagreed.
   */
  shares?: RecipientShareDto[];
  ts: string;
  calls: WrapCallEventDto[];
}

/**
 * Project an outcome into the (breach, breachReason) pair stored on Call.
 * Exported for unit testing and for use by services that ingest legacy
 * shapes. Only `latency_breach` and `server_error` are pool breaches.
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
      return { breach: false, breachReason: "client_error" };
    case "network_error":
      return { breach: false, breachReason: "network_error" };
  }
}
