/** Mirrors `PactCore.RecipientKind`. */
export enum RecipientKind {
  Treasury  = 0,
  Affiliate = 1,
}

/** Mirrors `PactCore.SettlementStatus`. */
export enum SettlementStatus {
  Unsettled          = 0,
  Settled            = 1,
  Refunded           = 2,
  PoolDepleted       = 3,
  DelegateFailed     = 4,
  ExposureCapClamped = 5,
}

export interface FeeRecipient {
  kind:        RecipientKind;
  destination: string; // 0x-address
  bps:         number; // 0..MAX_TOTAL_FEE_BPS
}

export interface EndpointConfig {
  agentTokenId:       bigint;
  premiumPerCall:     bigint;
  refundOnBreach:     bigint;
  latencySloMs:       number;
  exposureCapPerHour: bigint;
  paused:             boolean;
  exists:             boolean;
}

/** Settler input record for `PactCore.settleBatch(records[])`. */
export interface SettlementRecord {
  callId:     `0x${string}`; // bytes16
  slug:       `0x${string}`; // bytes16
  agent:      string;        // 0x-address
  breach:     boolean;
  premiumWei: bigint;
  refundWei:  bigint;
  rootHash:   `0x${string}`; // bytes32, single value — there's no separate CID on 0G Storage
}
