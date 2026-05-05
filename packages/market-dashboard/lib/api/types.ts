export interface Stats {
  totalPremiums: number;   // USDC micro-units (6 decimals)
  totalRefunds: number;    // USDC micro-units
  callsInsured: number;
  poolBalance: number;     // USDC micro-units
  activeEndpoints: number;
  activeAgents: number;
}

export interface CallEvent {
  id: string;
  agentPubkey: string;
  endpointUrl: string;
  endpointName: string;
  premium: number;         // USDC micro-units
  refund: number;          // USDC micro-units (0 if not claimed)
  latencyMs: number;
  status: "ok" | "timeout" | "error";
  ts: string;              // ISO timestamp
}

export interface Endpoint {
  id: string;
  url: string;
  name: string;
  flatFee: number;         // USDC micro-units
  percentFee: number;      // basis points
  slaMs: number;
  calls24h: number;
  failures24h: number;
  failureRate24h: number;  // 0-1
  avgLatencyMs: number;
  totalPremiums: number;
  totalRefunds: number;
  isActive: boolean;
}

export interface AgentWalletState {
  pubkey: string;
  balance: number;         // USDC micro-units
  pendingRefund: number;   // USDC micro-units
  totalPremiumsPaid: number;
  totalRefundsClaimed: number;
  callCount: number;
  lastActivity: string | null;
}

export interface AgentHistory {
  agent: AgentWalletState;
  recentCalls: CallEvent[];
}
