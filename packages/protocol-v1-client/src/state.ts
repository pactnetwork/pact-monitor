/**
 * State account TypeScript shapes + decoders for `pact-network-v1-pinocchio`.
 *
 * Layouts mirror `src/state.rs` (#[repr(C)] structs with explicit padding).
 * Pubkeys are returned as base58 strings to keep this module independent of
 * `@solana/web3.js`'s `PublicKey` (callers wrap when needed). u64/i64 are
 * returned as `bigint`.
 *
 * NOTE: When the on-chain account is larger than the parsed struct (rare;
 * accounts are sized exactly to LEN), we read only the first LEN bytes. We
 * never assume zero-fill of trailing bytes.
 */
import { PublicKey } from "@solana/web3.js";

import { MAX_FEE_RECIPIENTS } from "./constants.js";

/** SPL Token-style 32-byte address rendered as base58. */
export type Pubkey = string;

/** Mirror of `state.rs::FeeRecipientKind`. */
export enum FeeRecipientKind {
  Treasury = 0,
  AffiliateAta = 1,
  AffiliatePda = 2,
}

/** 48-byte fixed-layout entry (see `state.rs::FeeRecipient`). */
export interface FeeRecipient {
  kind: FeeRecipientKind;
  destination: Pubkey;
  bps: number;
}

/** Bytes per encoded FeeRecipient. */
export const FEE_RECIPIENT_LEN = 48;
/** Total length in bytes of a CoveragePool account. */
export const COVERAGE_POOL_LEN = 160;
/** Total length in bytes of an EndpointConfig account. */
export const ENDPOINT_CONFIG_LEN = 544;
/** Total length in bytes of a CallRecord account. */
export const CALL_RECORD_LEN = 104;
/** Total length in bytes of a SettlementAuthority account. */
export const SETTLEMENT_AUTHORITY_LEN = 48;
/** Total length in bytes of a Treasury account. */
export const TREASURY_LEN = 80;
/** Total length in bytes of a ProtocolConfig account. */
export const PROTOCOL_CONFIG_LEN = 464;

function toView(data: Buffer | Uint8Array): { view: DataView; bytes: Uint8Array } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { view, bytes };
}

function readPubkey(bytes: Uint8Array, offset: number): Pubkey {
  return new PublicKey(bytes.slice(offset, offset + 32)).toBase58();
}

/**
 * Decode a single FeeRecipient entry at the given byte offset.
 *
 * Layout (48 bytes):
 *   0:      kind u8
 *   1..7:   _pad0
 *   8..40:  destination [u8;32]
 *   40..42: bps u16 LE
 *   42..48: _pad1
 */
export function decodeFeeRecipient(
  data: Buffer | Uint8Array,
  offset = 0
): FeeRecipient {
  const { view, bytes } = toView(data);
  if (bytes.length < offset + FEE_RECIPIENT_LEN) {
    throw new Error(
      `decodeFeeRecipient: need ${FEE_RECIPIENT_LEN} bytes at offset ${offset}, got ${bytes.length - offset}`
    );
  }
  const kindByte = bytes[offset];
  if (kindByte > FeeRecipientKind.AffiliatePda) {
    throw new Error(`decodeFeeRecipient: unknown kind ${kindByte}`);
  }
  return {
    kind: kindByte as FeeRecipientKind,
    destination: readPubkey(bytes, offset + 8),
    bps: view.getUint16(offset + 40, true),
  };
}

/** Decode the active prefix of a fee_recipients array (with explicit count). */
export function decodeFeeRecipientArray(
  data: Buffer | Uint8Array,
  baseOffset: number,
  count: number
): FeeRecipient[] {
  if (count > MAX_FEE_RECIPIENTS) {
    throw new Error(
      `fee_recipient_count ${count} > MAX_FEE_RECIPIENTS ${MAX_FEE_RECIPIENTS}`
    );
  }
  const out: FeeRecipient[] = [];
  for (let i = 0; i < count; i++) {
    out.push(decodeFeeRecipient(data, baseOffset + i * FEE_RECIPIENT_LEN));
  }
  return out;
}

/** Mirror of `state.rs::CoveragePool`. */
export interface CoveragePool {
  bump: number;
  authority: Pubkey;
  usdcMint: Pubkey;
  usdcVault: Pubkey;
  endpointSlug: Uint8Array;
  totalDeposits: bigint;
  totalPremiums: bigint;
  totalRefunds: bigint;
  currentBalance: bigint;
  createdAt: bigint;
}

/**
 * Decode a CoveragePool account.
 *
 * Layout (160 bytes):
 *   0:       bump u8
 *   1..8:    _padding0
 *   8..40:   authority Pubkey
 *   40..72:  usdc_mint Pubkey
 *   72..104: usdc_vault Pubkey
 *   104..120: endpoint_slug [u8;16]
 *   120..128: total_deposits u64
 *   128..136: total_premiums u64
 *   136..144: total_refunds u64
 *   144..152: current_balance u64
 *   152..160: created_at i64
 */
export function decodeCoveragePool(data: Buffer | Uint8Array): CoveragePool {
  const { view, bytes } = toView(data);
  if (bytes.length < COVERAGE_POOL_LEN) {
    throw new Error(
      `decodeCoveragePool: need ${COVERAGE_POOL_LEN} bytes, got ${bytes.length}`
    );
  }
  return {
    bump: bytes[0],
    authority: readPubkey(bytes, 8),
    usdcMint: readPubkey(bytes, 40),
    usdcVault: readPubkey(bytes, 72),
    endpointSlug: bytes.slice(104, 120),
    totalDeposits: view.getBigUint64(120, true),
    totalPremiums: view.getBigUint64(128, true),
    totalRefunds: view.getBigUint64(136, true),
    currentBalance: view.getBigUint64(144, true),
    createdAt: view.getBigInt64(152, true),
  };
}

/** Mirror of `state.rs::EndpointConfig`. */
export interface EndpointConfig {
  bump: number;
  paused: boolean;
  slug: Uint8Array;
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
  currentPeriodStart: bigint;
  currentPeriodRefunds: bigint;
  totalCalls: bigint;
  totalBreaches: bigint;
  totalPremiums: bigint;
  totalRefunds: bigint;
  lastUpdated: bigint;
  coveragePool: Pubkey;
  feeRecipientCount: number;
  feeRecipients: FeeRecipient[];
}

/**
 * Decode an EndpointConfig account.
 *
 * Layout (544 bytes — see state.rs::EndpointConfig):
 *   0:       bump u8
 *   1:       paused u8
 *   2..8:    _padding0
 *   8..24:   slug [u8;16]
 *   24..32:  flat_premium_lamports u64
 *   32..34:  percent_bps u16
 *   34..40:  _padding1
 *   40..44:  sla_latency_ms u32
 *   44..48:  _padding2
 *   48..56:  imputed_cost_lamports u64
 *   56..64:  exposure_cap_per_hour_lamports u64
 *   64..72:  current_period_start i64
 *   72..80:  current_period_refunds u64
 *   80..88:  total_calls u64
 *   88..96:  total_breaches u64
 *   96..104: total_premiums u64
 *   104..112: total_refunds u64
 *   112..120: last_updated i64
 *   120..152: coverage_pool Pubkey
 *   152:     fee_recipient_count u8
 *   153..160: _padding3
 *   160..544: fee_recipients [FeeRecipient;8]  (48 each)
 */
export function decodeEndpointConfig(
  data: Buffer | Uint8Array
): EndpointConfig {
  const { view, bytes } = toView(data);
  if (bytes.length < ENDPOINT_CONFIG_LEN) {
    throw new Error(
      `decodeEndpointConfig: need ${ENDPOINT_CONFIG_LEN} bytes, got ${bytes.length}`
    );
  }
  const feeRecipientCount = bytes[152];
  return {
    bump: bytes[0],
    paused: bytes[1] !== 0,
    slug: bytes.slice(8, 24),
    flatPremiumLamports: view.getBigUint64(24, true),
    percentBps: view.getUint16(32, true),
    slaLatencyMs: view.getUint32(40, true),
    imputedCostLamports: view.getBigUint64(48, true),
    exposureCapPerHourLamports: view.getBigUint64(56, true),
    currentPeriodStart: view.getBigInt64(64, true),
    currentPeriodRefunds: view.getBigUint64(72, true),
    totalCalls: view.getBigUint64(80, true),
    totalBreaches: view.getBigUint64(88, true),
    totalPremiums: view.getBigUint64(96, true),
    totalRefunds: view.getBigUint64(104, true),
    lastUpdated: view.getBigInt64(112, true),
    coveragePool: readPubkey(bytes, 120),
    feeRecipientCount,
    feeRecipients: decodeFeeRecipientArray(bytes, 160, feeRecipientCount),
  };
}

/** Mirror of `state.rs::CallRecord`. */
export interface CallRecord {
  bump: number;
  breach: boolean;
  callId: Uint8Array;
  agent: Pubkey;
  endpointSlug: Uint8Array;
  premiumLamports: bigint;
  refundLamports: bigint;
  latencyMs: number;
  timestamp: bigint;
}

/**
 * Decode a CallRecord account.
 *
 * Layout (104 bytes — see state.rs::CallRecord):
 *   0:       bump u8
 *   1:       breach u8
 *   2..8:    _padding0
 *   8..24:   call_id [u8;16]
 *   24..56:  agent Pubkey
 *   56..72:  endpoint_slug [u8;16]
 *   72..80:  premium_lamports u64
 *   80..88:  refund_lamports u64
 *   88..92:  latency_ms u32
 *   92..96:  _padding1
 *   96..104: timestamp i64
 */
export function decodeCallRecord(data: Buffer | Uint8Array): CallRecord {
  const { view, bytes } = toView(data);
  if (bytes.length < CALL_RECORD_LEN) {
    throw new Error(
      `decodeCallRecord: need ${CALL_RECORD_LEN} bytes, got ${bytes.length}`
    );
  }
  return {
    bump: bytes[0],
    breach: bytes[1] !== 0,
    callId: bytes.slice(8, 24),
    agent: readPubkey(bytes, 24),
    endpointSlug: bytes.slice(56, 72),
    premiumLamports: view.getBigUint64(72, true),
    refundLamports: view.getBigUint64(80, true),
    latencyMs: view.getUint32(88, true),
    timestamp: view.getBigInt64(96, true),
  };
}

/** Mirror of `state.rs::SettlementAuthority`. */
export interface SettlementAuthority {
  bump: number;
  signer: Pubkey;
  setAt: bigint;
}

/**
 * Decode a SettlementAuthority account.
 *
 * Layout (48 bytes):
 *   0:       bump u8
 *   1..8:    _padding0
 *   8..40:   signer Pubkey
 *   40..48:  set_at i64
 */
export function decodeSettlementAuthority(
  data: Buffer | Uint8Array
): SettlementAuthority {
  const { view, bytes } = toView(data);
  if (bytes.length < SETTLEMENT_AUTHORITY_LEN) {
    throw new Error(
      `decodeSettlementAuthority: need ${SETTLEMENT_AUTHORITY_LEN} bytes, got ${bytes.length}`
    );
  }
  return {
    bump: bytes[0],
    signer: readPubkey(bytes, 8),
    setAt: view.getBigInt64(40, true),
  };
}

/** Mirror of `state.rs::Treasury`. */
export interface Treasury {
  bump: number;
  authority: Pubkey;
  usdcVault: Pubkey;
  setAt: bigint;
}

/**
 * Decode a Treasury account.
 *
 * Layout (80 bytes):
 *   0:       bump u8
 *   1..8:    _padding0
 *   8..40:   authority Pubkey
 *   40..72:  usdc_vault Pubkey
 *   72..80:  set_at i64
 */
export function decodeTreasury(data: Buffer | Uint8Array): Treasury {
  const { view, bytes } = toView(data);
  if (bytes.length < TREASURY_LEN) {
    throw new Error(
      `decodeTreasury: need ${TREASURY_LEN} bytes, got ${bytes.length}`
    );
  }
  return {
    bump: bytes[0],
    authority: readPubkey(bytes, 8),
    usdcVault: readPubkey(bytes, 40),
    setAt: view.getBigInt64(72, true),
  };
}

/** Mirror of `state.rs::ProtocolConfig`. */
export interface ProtocolConfig {
  bump: number;
  authority: Pubkey;
  usdcMint: Pubkey;
  maxTotalFeeBps: number;
  defaultFeeRecipientCount: number;
  defaultFeeRecipients: FeeRecipient[];
}

/**
 * Decode a ProtocolConfig account.
 *
 * Layout (464 bytes):
 *   0:       bump u8
 *   1..8:    _padding0
 *   8..40:   authority Pubkey
 *   40..72:  usdc_mint Pubkey
 *   72..74:  max_total_fee_bps u16
 *   74:      default_fee_recipient_count u8
 *   75..80:  _padding1
 *   80..464: default_fee_recipients [FeeRecipient;8]
 */
export function decodeProtocolConfig(
  data: Buffer | Uint8Array
): ProtocolConfig {
  const { view, bytes } = toView(data);
  if (bytes.length < PROTOCOL_CONFIG_LEN) {
    throw new Error(
      `decodeProtocolConfig: need ${PROTOCOL_CONFIG_LEN} bytes, got ${bytes.length}`
    );
  }
  const count = bytes[74];
  return {
    bump: bytes[0],
    authority: readPubkey(bytes, 8),
    usdcMint: readPubkey(bytes, 40),
    maxTotalFeeBps: view.getUint16(72, true),
    defaultFeeRecipientCount: count,
    defaultFeeRecipients: decodeFeeRecipientArray(bytes, 80, count),
  };
}
