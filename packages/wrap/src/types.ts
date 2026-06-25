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
 * Provenance of the breach verdict carried on a SettlementEvent (agent-tasks#10).
 * Records HOW Pact decided the outcome that authorizes a refund, so the settler,
 * indexer, and any analytics can tell a self-observed verdict apart from a
 * client-claimed one without re-deriving it.
 *
 *   - "pact_observed":  Pact's own server made the upstream fetch, timed it, and
 *                       classified the real Response (gateway / `wrapFetch`). The
 *                       client cannot supply or alter this verdict. Authoritative.
 *   - "client_attested": the client reported the outcome and Pact accepted it
 *                       (off-gateway / x402 facilitator `register`). Zero-friction
 *                       by design; trustworthy ONLY up to the abuse controls and
 *                       the on-chain hourly exposure cap. Carries moral hazard.
 *   - "oracle":         (v2, not produced today) an external attestation
 *                       (zkTLS / TEE / cosigned receipt) verified the outcome.
 *                       A seam: adding it later needs a new PRODUCER only — the
 *                       settler / indexer / on-chain executor are unchanged.
 *
 * When ABSENT on an event (pre-#10 producers), consumers infer per-path:
 * a `source: "pay.sh"` event is `client_attested`; everything else is
 * `pact_observed`. See MECHANISM_MAP.md / VERDICT_SOURCE_DESIGN.md.
 */
export type VerdictSource = "pact_observed" | "client_attested" | "oracle";

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
  /**
   * Network identifier (WP-MN-03a). Optional during the migration window;
   * consumers default to `'solana-devnet'` when absent so legacy pre-MN
   * settlers can still publish events.
   *
   * Values come from `getChain(name).network` in `@pact-network/shared`.
   * Examples: "solana-devnet", "solana-mainnet", "arc-testnet".
   */
  network?: string;
  /**
   * Provenance of the verdict (agent-tasks#10). OPTIONAL for backward
   * compatibility (mirrors `network?` above): pre-#10 producers omit it and
   * consumers infer it per-path. `wrapFetch` stamps `"pact_observed"` because
   * the gateway self-observed the call.
   */
  verdictSource?: VerdictSource;
}
