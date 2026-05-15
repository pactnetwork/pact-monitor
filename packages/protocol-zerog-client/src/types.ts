import type { Address, Hex } from 'viem';

/** Mirrors `PactCore.RecipientKind`. */
export enum RecipientKind {
  Treasury  = 0,
  Affiliate = 1,
}

/**
 * Mirrors `PactCore.SettlementStatus`. Discriminants are shifted +1 from the
 * Solana v1 program: `Unsettled = 0` is the dedup sentinel in the on-chain
 * `callStatus` mapping. There is NO `Refunded` state — a full breach refund
 * is `Settled`.
 */
export enum SettlementStatus {
  Unsettled          = 0,
  Settled            = 1,
  DelegateFailed     = 2,
  PoolDepleted       = 3,
  ExposureCapClamped = 4,
}

export interface FeeRecipient {
  kind:        RecipientKind;
  destination: Address;
  bps:         number; // 0..MAX_SINGLE_RECIPIENT_BPS per entry; Σ ≤ MAX_TOTAL_FEE_BPS
}

/**
 * Mirrors `PactCore.EndpointConfig` — field order matches the Solidity
 * declaration exactly, which is also the tuple order the auto-generated
 * `endpointConfig(bytes16)` getter returns. `bindings.ts` relies on this.
 */
export interface EndpointConfig {
  // identity
  agentTokenId:         bigint;  // uint256
  // pricing
  flatPremium:          bigint;  // uint96
  percentBps:           number;  // uint16
  imputedCost:          bigint;  // uint96
  latencySloMs:         number;  // uint16
  // exposure-cap rolling window
  exposureCapPerHour:   bigint;  // uint96
  currentPeriodStart:   bigint;  // uint64 (unix seconds)
  currentPeriodRefunds: bigint;  // uint96
  // lifetime stats
  totalCalls:           bigint;  // uint64
  totalBreaches:        bigint;  // uint64
  totalPremiums:        bigint;  // uint96
  totalRefunds:         bigint;  // uint96
  lastUpdated:          bigint;  // uint64
  // flags
  paused:               boolean;
  exists:               boolean;
}

/**
 * Mirrors `PactCore.EndpointConfigUpdate`. Only the 6 mutable config fields
 * are settable — stats counters, the exposure-cap window, and the
 * `paused`/`exists` flags are NOT changeable through this path (use
 * `pauseEndpoint` for `paused`). Each `setX` flag gates whether the paired
 * value is written; `false` leaves the on-chain field untouched (so a
 * legitimate "set to 0" is distinct from "no change").
 */
export interface EndpointConfigUpdate {
  setAgentTokenId:       boolean; agentTokenId:       bigint;
  setFlatPremium:        boolean; flatPremium:        bigint;
  setPercentBps:         boolean; percentBps:         number;
  setImputedCost:        boolean; imputedCost:        bigint;
  setLatencySloMs:       boolean; latencySloMs:       number;
  setExposureCapPerHour: boolean; exposureCapPerHour: bigint;
}

/** Mirrors `PactCore.Pool`. */
export interface Pool {
  balance:       bigint; // uint128 — current mUSDC residual
  totalDeposits: bigint; // uint128 — lifetime in via topUpCoveragePool
}

/**
 * Settler input record for `PactCore.settleBatch(records[])`.
 * `callId` is the 16-byte UUID form — see `callId.ts` for the encoder.
 */
export interface SettlementRecord {
  callId:     Hex;     // bytes16
  slug:       Hex;     // bytes16
  agent:      Address;
  breach:     boolean;
  premiumWei: bigint;  // uint96
  refundWei:  bigint;  // uint96 — requested refund (settler-computed breach amount)
  timestamp:  bigint;  // uint64 — unix seconds; contract rejects timestamp > block.timestamp
  rootHash:   Hex;     // bytes32 — 0G Storage rootHash (no separate CID)
}
