/**
 * Observability return types.
 *
 * V1 has NO Policy PDA. `policy()` reports the agent's *insurable state*:
 * the USDC ATA balance, the SPL delegation to the SettlementAuthority, and
 * (best-effort) the indexer's lifetime aggregates. `estimate()` derives the
 * quote straight from the on-chain `EndpointConfig` (flat + percent), because
 * in V1 the premium/refund are endpoint-fixed — the per-call `insure` /
 * x402-declared value does NOT influence what the settler charges.
 */
export interface AgentPolicyState {
  agentPubkey: string;
  ataPubkey: string;
  ataBalanceLamports: bigint;
  allowanceLamports: bigint;
  eligible: boolean;
  reason?: string;
  /** Indexer lifetime aggregates; zeros if the indexer is unreachable (B2). */
  totalPremiumsLamports: bigint;
  totalRefundsLamports: bigint;
  callCount: bigint;
  lastCallAt: Date | null;
}

export interface AgentStats {
  totalCalls: number;
  reconciledCalls: number;
  pendingCalls: number;
  /** Provisional, from X-Pact-* response headers (pre-settlement). */
  totalPremiumLamportsObserved: bigint;
  totalRefundLamportsObserved: bigint;
  bySlug: Record<string, { calls: number; breaches: number }>;
}

export interface ClaimRecord {
  callId: string;
  slug: string;
  refundLamports: bigint;
  settledAt: Date;
  txSignature: string;
}

export interface PremiumEstimate {
  slug: string;
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  paused: boolean;
}
