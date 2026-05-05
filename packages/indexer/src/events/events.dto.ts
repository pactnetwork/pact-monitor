export interface CallEventDto {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  latencyMs: number;
  breach: boolean;
  breachReason?: string;
  source?: string;
  ts: string;
  settledAt: string;
  signature: string;
}

export interface SettlementEventDto {
  signature: string;
  batchSize: number;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  ts: string;
  calls: CallEventDto[];
}
