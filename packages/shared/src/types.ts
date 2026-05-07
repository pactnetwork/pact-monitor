export interface SettlementEvent {
  call_id: string;
  agent_wallet: string;
  endpoint_slug: string;
  premium_lamports: number;
  refund_lamports: number;
  latency_ms: number;
  breach: boolean;
  timestamp: number;
}
