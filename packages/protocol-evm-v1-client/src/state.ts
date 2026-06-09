/**
 * View-call return decoders + event-log decoders + protocol enums — the EVM
 * analogue of `protocol-v1-client/src/state.ts` (design spec §5). On EVM there
 * are no account buffers to hand-decode (§4 #2/#4); state is read via view
 * calls and the on-chain events that are the indexer truth source (§4 #3).
 * These are thin, ABI-faithful viem wrappers over the committed ABI (D-A).
 */
import {
  decodeFunctionResult,
  decodeEventLog,
  type Address,
  type Hex,
} from "viem";

import { PactRegistryAbi } from "./abi/PactRegistry.js";
import { PactPoolAbi } from "./abi/PactPool.js";
import { PactEventsAbi } from "./abi/PactEvents.js";

/** Per-call settlement outcome — mirrors the Solana `SettlementStatus` enum. */
export enum SettlementStatus {
  Settled = 0,
  DelegateFailed = 1,
  PoolDepleted = 2,
  ExposureCapClamped = 3,
}

/** Fee-recipient kind — preserved on the wire/events for indexer parity (§4 #7). */
export enum FeeRecipientKind {
  Treasury = 0,
  AffiliateAta = 1,
  AffiliatePda = 2,
}

export interface FeeRecipient {
  kind: number;
  destination: Address;
  bps: number;
}

/** Mirrors `IPactRegistry.EndpointConfig`. */
export interface EndpointConfig {
  paused: boolean;
  flatPremium: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCost: bigint;
  exposureCapPerHour: bigint;
  totalCalls: bigint;
  totalBreaches: bigint;
  totalPremiums: bigint;
  totalRefunds: bigint;
  currentPeriodStart: bigint;
  currentPeriodRefunds: bigint;
  lastUpdated: bigint;
  feeRecipientCount: number;
  feeRecipients: readonly FeeRecipient[];
}

/** Mirrors `IPactPool.PoolState`. */
export interface PoolState {
  currentBalance: bigint;
  totalDeposits: bigint;
  totalPremiums: bigint;
  totalRefunds: bigint;
  createdAt: bigint;
}

/** Decode a `getEndpoint(slug)` view return. */
export function decodeEndpointConfig(data: Hex): EndpointConfig {
  return decodeFunctionResult({
    abi: PactRegistryAbi,
    functionName: "getEndpoint",
    data,
  }) as unknown as EndpointConfig;
}

/** Decode a `balanceOf(slug)` view return. */
export function decodePoolState(data: Hex): PoolState {
  return decodeFunctionResult({
    abi: PactPoolAbi,
    functionName: "balanceOf",
    data,
  }) as unknown as PoolState;
}

export function decodeIsRegistered(data: Hex): boolean {
  return decodeFunctionResult({
    abi: PactRegistryAbi,
    functionName: "isRegistered",
    data,
  }) as boolean;
}

export function decodeProtocolPaused(data: Hex): boolean {
  return decodeFunctionResult({
    abi: PactRegistryAbi,
    functionName: "protocolPaused",
    data,
  }) as boolean;
}

export function decodeAuthority(data: Hex): Address {
  return decodeFunctionResult({
    abi: PactRegistryAbi,
    functionName: "authority",
    data,
  }) as Address;
}

export function decodeTreasuryVault(data: Hex): Address {
  return decodeFunctionResult({
    abi: PactRegistryAbi,
    functionName: "treasuryVault",
    data,
  }) as Address;
}

export function decodeMaxTotalFeeBps(data: Hex): number {
  return decodeFunctionResult({
    abi: PactRegistryAbi,
    functionName: "maxTotalFeeBps",
    data,
  }) as number;
}

export interface DecodedPactEvent {
  eventName: string;
  args: Record<string, unknown>;
}

/**
 * Decode a protocol event log against the `PactEvents` ABI (the indexer
 * truth source, §4 #3): EndpointRegistered, EndpointConfigUpdated,
 * EndpointPaused, ProtocolPaused, FeeRecipientsUpdated, PoolToppedUp,
 * CallSettled. The per-call `CallSettled.status` is the `SettlementStatus`
 * ordinal (uint8) — map via the enum above.
 */
export function decodePactEventLog(log: {
  data: Hex;
  topics: [signature: Hex, ...args: Hex[]] | [] | Hex[];
}): DecodedPactEvent {
  const decoded = decodeEventLog({
    abi: PactEventsAbi,
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return {
    eventName: decoded.eventName as string,
    args: (decoded.args ?? {}) as Record<string, unknown>,
  };
}
