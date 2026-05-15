import type { Log } from 'ethers';
import { SettlementStatus } from './types.js';

/**
 * Decoded `CallSettled(bytes16 indexed callId, bytes16 indexed slug, address indexed agent,
 *                     uint8 status, uint96 premium, uint96 refund, bytes32 rootHash)`.
 */
export interface CallSettledEvent {
  callId:   `0x${string}`;
  slug:     `0x${string}`;
  agent:    string;
  status:   SettlementStatus;
  premium:  bigint;
  refund:   bigint;
  rootHash: `0x${string}`;
  txHash:   string;
  logIndex: number;
  blockNumber: number;
}

/**
 * Decode a raw ethers `Log` for the `CallSettled` topic into a typed event.
 * The Contract instance handles topic matching; this is the
 * fallback decoder for indexer / out-of-band log reads.
 *
 * TODO(impl): wire up once PactCore ABI exists in `bindings.ts`. For now this
 * stub keeps the public API stable so callers can import the type today.
 */
export function decodeCallSettled(_log: Log): CallSettledEvent {
  throw new Error('decodeCallSettled: not implemented — needs PactCore ABI');
}
