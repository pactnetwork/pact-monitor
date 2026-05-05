/**
 * Public types for the dashboard's data layer.
 *
 * The shapes here mirror the indexer responses produced by Step D #59 (which
 * adds per-endpoint PoolState aggregates and SettlementRecipientShare records
 * to the indexer schema). All USDC amounts are in base units (6 decimals).
 */

export interface RecipientEarnings {
  /** Recipient destination ATA. */
  destination: string;
  /** Recipient kind: treasury, affiliate_ata, affiliate_pda. */
  kind: "treasury" | "affiliate_ata" | "affiliate_pda";
  /** Lifetime earned in USDC base units. */
  totalEarned: number;
  /** Display label (e.g. "Treasury", "Helius affiliate"). */
  label: string;
}

export interface Stats {
  /** Sum of premiums collected across ALL CoveragePools. */
  totalPremiums: number;
  /** Sum of refunds paid back to agent ATAs across all pools. */
  totalRefunds: number;
  /** Calls covered (unique CallRecord PDAs). */
  callsInsured: number;
  /** Aggregate USDC across all CoveragePool vaults. */
  poolBalanceAggregate: number;
  /** Lifetime USDC routed to the Treasury vault. */
  treasuryEarned: number;
  /** Active endpoints (registered + not paused). */
  activeEndpoints: number;
  /** Active agents (held SPL approval + had a call this epoch). */
  activeAgents: number;
  /** Top earners by integrator rewards. */
  topRecipients: RecipientEarnings[];
}

export interface SettlementRecipientShare {
  destination: string;
  kind: "treasury" | "affiliate_ata" | "affiliate_pda";
  bps: number;
  amount: number;
}

export interface CallEvent {
  id: string;
  agentPubkey: string;
  endpointSlug: string;
  endpointName: string;
  /** Premium debited from agent ATA in USDC base units. */
  premium: number;
  /** Refund credited back to agent ATA on breach. */
  refund: number;
  latencyMs: number;
  status: "ok" | "timeout" | "error";
  /** Per-recipient share of the premium when settled (treasury, affiliates). */
  recipientShares?: SettlementRecipientShare[];
  /** Net retained by the CoveragePool after fee fan-out. */
  poolRetained?: number;
  ts: string;
}

export interface FeeRecipientSummary {
  kind: "treasury" | "affiliate_ata" | "affiliate_pda";
  destination: string;
  bps: number;
  /** Display label, e.g. "Treasury 10%" or "Affiliate 5%". */
  label: string;
}

export interface Endpoint {
  id: string;
  slug: string;
  url: string;
  name: string;
  flatFee: number;
  percentFee: number;
  slaMs: number;
  calls24h: number;
  failures24h: number;
  failureRate24h: number;
  avgLatencyMs: number;
  totalPremiums: number;
  totalRefunds: number;
  /** Current USDC balance held in this endpoint's CoveragePool vault. */
  poolBalance: number;
  /** Active fee recipient list (after register_endpoint or update_fee_recipients). */
  feeRecipients: FeeRecipientSummary[];
  /** bps the pool retains after all recipients (10000 - sum(bps)). */
  poolRetainedBps: number;
  isActive: boolean;
}

/**
 * Result of inspecting an agent's USDC ATA on-chain. Mirrors the
 * `BalanceCheckResult` shape exported by `@pact-network/wrap` so the dashboard
 * and the SDK speak the same vocabulary.
 */
export interface AgentInsurableSnapshot {
  pubkey: string;
  /** Spendable USDC in the agent's ATA (base units). */
  ataBalance: number;
  /** Currently delegated to SettlementAuthority (base units). */
  allowance: number;
  /** Both balance and allowance >= min_premium. */
  eligible: boolean;
  /** Human-readable reason when eligible == false. */
  reason?: string;
  /** Lifetime premiums debited (sum across all calls). */
  totalPremiumsPaid: number;
  /** Lifetime refunds credited back to this ATA. */
  totalRefundsReceived: number;
  callCount: number;
  lastActivity: string | null;
}

export interface AgentHistory {
  agent: AgentInsurableSnapshot;
  recentCalls: CallEvent[];
}
