import {
  type Address,
  type Hex,
  type Log,
  decodeEventLog,
} from 'viem';
import { pactCoreAbi } from './abi.js';
import { SettlementStatus } from './types.js';

/** Provenance attached to every decoded event. */
export interface LogMeta {
  txHash:      Hex;
  logIndex:    number;
  blockNumber: bigint;
}

export interface EndpointRegisteredEvent extends LogMeta {
  eventName: 'EndpointRegistered';
  slug:               Hex;
  agentTokenId:       bigint;
  flatPremium:        bigint;
  percentBps:         number;
  imputedCost:        bigint;
  latencySloMs:       number;
  exposureCapPerHour: bigint;
}
export interface EndpointConfigUpdatedEvent extends LogMeta {
  eventName: 'EndpointConfigUpdated';
  slug: Hex;
}
export interface FeeRecipientsUpdatedEvent extends LogMeta {
  eventName: 'FeeRecipientsUpdated';
  slug: Hex;
}
export interface PoolToppedUpEvent extends LogMeta {
  eventName: 'PoolToppedUp';
  slug:   Hex;
  funder: Address;
  amount: bigint;
}
export interface CallSettledEvent extends LogMeta {
  eventName: 'CallSettled';
  callId:       Hex;
  slug:         Hex;
  agent:        Address;
  status:       SettlementStatus;
  premium:      bigint;
  refund:       bigint;  // requested
  actualRefund: bigint;  // what actually paid (round-2 C1; gap on clamp)
  rootHash:     Hex;
}
export interface RecipientPaidEvent extends LogMeta {
  eventName: 'RecipientPaid';
  slug:      Hex;
  recipient: Address;
  amount:    bigint;
}
export interface EndpointPausedEvent extends LogMeta {
  eventName: 'EndpointPaused';
  slug:   Hex;
  paused: boolean;
}
export interface ProtocolPausedEvent extends LogMeta {
  eventName: 'ProtocolPaused';
  paused: boolean;
}

export type PactCoreEvent =
  | EndpointRegisteredEvent
  | EndpointConfigUpdatedEvent
  | FeeRecipientsUpdatedEvent
  | PoolToppedUpEvent
  | CallSettledEvent
  | RecipientPaidEvent
  | EndpointPausedEvent
  | ProtocolPausedEvent;

/** The 8 PactCore event names — also used by the test count assertion. */
export const PACT_CORE_EVENT_NAMES = [
  'EndpointRegistered',
  'EndpointConfigUpdated',
  'FeeRecipientsUpdated',
  'PoolToppedUp',
  'CallSettled',
  'RecipientPaid',
  'EndpointPaused',
  'ProtocolPaused',
] as const;

type RawLog = Pick<Log, 'data' | 'topics'> & {
  transactionHash: Hex | null;
  logIndex:        number | null;
  blockNumber:     bigint | null;
};

function meta(log: RawLog): LogMeta {
  return {
    txHash:      log.transactionHash ?? '0x',
    logIndex:    log.logIndex ?? -1,
    blockNumber: log.blockNumber ?? 0n,
  };
}

/**
 * Decode a single PactCore log into a typed, discriminated event. Throws if
 * the log doesn't match any PactCore event (use a try/catch or pre-filter by
 * topic if scanning mixed logs). viem decodes the 3 `indexed` params on
 * `CallSettled` from topics and the rest from data.
 */
export function decodePactCoreEvent(log: RawLog): PactCoreEvent {
  const { eventName, args } = decodeEventLog({
    abi: pactCoreAbi,
    data: log.data,
    topics: log.topics,
  });
  const m = meta(log);
  const a = args as Record<string, unknown>;

  switch (eventName) {
    case 'EndpointRegistered':
      return {
        eventName, ...m,
        slug:               a.slug as Hex,
        agentTokenId:       a.agentTokenId as bigint,
        flatPremium:        a.flatPremium as bigint,
        percentBps:         Number(a.percentBps),
        imputedCost:        a.imputedCost as bigint,
        latencySloMs:       Number(a.latencySloMs),
        exposureCapPerHour: a.exposureCapPerHour as bigint,
      };
    case 'EndpointConfigUpdated':
      return { eventName, ...m, slug: a.slug as Hex };
    case 'FeeRecipientsUpdated':
      return { eventName, ...m, slug: a.slug as Hex };
    case 'PoolToppedUp':
      return {
        eventName, ...m,
        slug:   a.slug as Hex,
        funder: a.funder as Address,
        amount: a.amount as bigint,
      };
    case 'CallSettled':
      return {
        eventName, ...m,
        callId:       a.callId as Hex,
        slug:         a.slug as Hex,
        agent:        a.agent as Address,
        status:       Number(a.status) as SettlementStatus,
        premium:      a.premium as bigint,
        refund:       a.refund as bigint,
        actualRefund: a.actualRefund as bigint,
        rootHash:     a.rootHash as Hex,
      };
    case 'RecipientPaid':
      return {
        eventName, ...m,
        slug:      a.slug as Hex,
        recipient: a.recipient as Address,
        amount:    a.amount as bigint,
      };
    case 'EndpointPaused':
      return {
        eventName, ...m,
        slug:   a.slug as Hex,
        paused: a.paused as boolean,
      };
    case 'ProtocolPaused':
      return { eventName, ...m, paused: a.paused as boolean };
    default:
      throw new Error(`decodePactCoreEvent: unhandled event ${eventName}`);
  }
}

/** Narrow helper kept for the indexer's hot path. */
export function decodeCallSettled(log: RawLog): CallSettledEvent {
  const ev = decodePactCoreEvent(log);
  if (ev.eventName !== 'CallSettled') {
    throw new Error(`decodeCallSettled: log is ${ev.eventName}, not CallSettled`);
  }
  return ev;
}
