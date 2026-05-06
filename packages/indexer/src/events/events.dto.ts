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
