// @pact-network/wrap — shared types.
//
// Only the wrap-needed subset of an endpoint's on-chain config is modeled
// here. The consumer (Pact Market proxy, BYO SDK, x402 facilitator, etc.) is
// responsible for fetching the full on-chain Endpoint account and projecting
// it down to this shape before calling wrapFetch().

export type Outcome =
  | "ok"
  | "latency_breach"
  | "server_error"
  | "client_error"
  | "network_error";

/**
 * Wrap-relevant slice of an endpoint's on-chain config. The consumer passes
 * this in per call; wrap does not load it from chain.
 */
export interface EndpointConfig {
  /** Stable slug, e.g. "helius", "birdeye-defi-trades". */
  slug: string;
  /** SLA latency threshold in milliseconds. Above this is `latency_breach`. */
  sla_latency_ms: number;
  /** Premium charged on a normal call, in lamports of the settlement mint. */
  flat_premium_lamports: bigint;
  /** Imputed cost refunded to the agent on a covered failure. */
  imputed_cost_lamports: bigint;
}

/**
 * Settlement event published to the EventSink fire-and-forget after every
 * wrapped call. Consumers (settler workers) consume these to debit/credit
 * the agent's escrow on-chain.
 *
 * NOTE: bigint fields are serialized as decimal strings so this round-trips
 * through JSON without precision loss.
 */
export interface SettlementEvent {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  /** bigint as decimal string, e.g. "1000". */
  premiumLamports: string;
  /** bigint as decimal string. */
  refundLamports: string;
  latencyMs: number;
  outcome: Outcome;
  /** ISO-8601 timestamp of when the wrapped call completed. */
  ts: string;
}
