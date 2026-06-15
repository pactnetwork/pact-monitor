/**
 * viem calldata builders — the EVM analogue of
 * `protocol-v1-client/src/instructions.ts` (design spec §5). Each builder
 * returns ABI-encoded `Hex` calldata for one protocol entrypoint, encoded
 * against the committed ABI (D-A), ready for `sendTransaction` /
 * `writeContract` by the settler `ChainAdapter` and the ops controller.
 *
 * Parity note: no Solana account-list assembly (§4 #2 — slug-keyed mappings,
 * not PDAs); a builder is just function-selector + args. The 16-byte slug
 * convention mirrors `protocol-v1-client`'s `slugBytes`.
 */
import {
  encodeFunctionData,
  stringToHex,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { PactRegistryAbi } from "./abi/PactRegistry.js";
import { PactPoolAbi } from "./abi/PactPool.js";
import { PactSettlerAbi } from "./abi/PactSettler.js";
import { MAX_FEE_RECIPIENTS } from "./constants.js";

const SLUG_LEN = 16;
const BYTES16_RE = /^0x[0-9a-fA-F]{32}$/;

/**
 * Canonical 16-byte slug: UTF-8, right-padded with zero (mirrors
 * `protocol-v1-client`'s `slugBytes`). Rejects > 16 bytes (parity with the
 * Solana `normalizeSlug` guard) rather than silently truncating.
 */
export function slugToBytes16(slug: string): Hex {
  const bytes = new TextEncoder().encode(slug);
  if (bytes.length > SLUG_LEN) {
    throw new Error(
      `endpoint slug must be <= ${SLUG_LEN} bytes (got ${bytes.length})`,
    );
  }
  return stringToHex(slug, { size: SLUG_LEN });
}

/** Accept a slug string OR an already-formed bytes16 hex; return bytes16. */
function asSlugBytes16(slugOrHex: string): Hex {
  return BYTES16_RE.test(slugOrHex)
    ? (slugOrHex.toLowerCase() as Hex)
    : slugToBytes16(slugOrHex);
}

/** Normalize a raw 16-byte id (e.g. callId) — must already be bytes16 hex. */
function asBytes16(id: string): Hex {
  if (!BYTES16_RE.test(id)) {
    throw new Error(`expected a 16-byte 0x hex value, got: ${id}`);
  }
  return id.toLowerCase() as Hex;
}

function asAddress(a: string): Address {
  if (!isAddress(a)) throw new Error(`invalid EVM address: ${a}`);
  return getAddress(a);
}

export interface FeeRecipientInput {
  /** 0 = Treasury, 1 = AffiliateAta, 2 = AffiliatePda (kind preserved, §4 #7). */
  kind: number;
  destination: Address | string;
  bps: number;
}

interface FeeRecipientWire {
  kind: number;
  destination: Address;
  bps: number;
}

/** The contract ABI requires a fixed-length `FeeRecipient[8]`. */
export type FeeRecipient8 = readonly [
  FeeRecipientWire,
  FeeRecipientWire,
  FeeRecipientWire,
  FeeRecipientWire,
  FeeRecipientWire,
  FeeRecipientWire,
  FeeRecipientWire,
  FeeRecipientWire,
];

/**
 * Pad a recipients list to the fixed `FeeRecipient[8]` the contract ABI
 * requires, zero-filling unused slots. Rejects > MAX_FEE_RECIPIENTS (8) —
 * the on-chain `FeeRecipientArrayTooLong` guard, surfaced client-side.
 */
export function padFeeRecipients(
  recipients: FeeRecipientInput[],
): FeeRecipient8 {
  if (recipients.length > MAX_FEE_RECIPIENTS) {
    throw new Error(
      `at most ${MAX_FEE_RECIPIENTS} fee recipients (got ${recipients.length})`,
    );
  }
  const out: FeeRecipientWire[] = recipients.map((r) => ({
    kind: r.kind,
    destination: asAddress(String(r.destination)),
    bps: r.bps,
  }));
  while (out.length < MAX_FEE_RECIPIENTS) {
    out.push({ kind: 0, destination: zeroAddress, bps: 0 });
  }
  // Provably exactly 8 entries by construction.
  return out as unknown as FeeRecipient8;
}

export interface RegisterEndpointInput {
  slug: string;
  flatPremium: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCost: bigint;
  exposureCapPerHour: bigint;
  feeRecipientsPresent: boolean;
  feeRecipientCount: number;
  feeRecipients: FeeRecipientInput[];
}

export function encodeRegisterEndpoint(i: RegisterEndpointInput): Hex {
  return encodeFunctionData({
    abi: PactRegistryAbi,
    functionName: "registerEndpoint",
    args: [
      asSlugBytes16(i.slug),
      i.flatPremium,
      i.percentBps,
      i.slaLatencyMs,
      i.imputedCost,
      i.exposureCapPerHour,
      i.feeRecipientsPresent,
      i.feeRecipientCount,
      padFeeRecipients(i.feeRecipients),
    ],
  });
}

export interface UpdateEndpointConfigInput {
  slug: string;
  flatPremium: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCost: bigint;
  exposureCapPerHour: bigint;
}

export function encodeUpdateEndpointConfig(i: UpdateEndpointConfigInput): Hex {
  return encodeFunctionData({
    abi: PactRegistryAbi,
    functionName: "updateEndpointConfig",
    args: [
      asSlugBytes16(i.slug),
      i.flatPremium,
      i.percentBps,
      i.slaLatencyMs,
      i.imputedCost,
      i.exposureCapPerHour,
    ],
  });
}

export function encodeUpdateFeeRecipients(
  slug: string,
  recipients: FeeRecipientInput[],
  count: number,
): Hex {
  return encodeFunctionData({
    abi: PactRegistryAbi,
    functionName: "updateFeeRecipients",
    args: [asSlugBytes16(slug), padFeeRecipients(recipients), count],
  });
}

export function encodePauseEndpoint(slug: string, paused: boolean): Hex {
  return encodeFunctionData({
    abi: PactRegistryAbi,
    functionName: "pauseEndpoint",
    args: [asSlugBytes16(slug), paused],
  });
}

export function encodePauseProtocol(paused: boolean): Hex {
  return encodeFunctionData({
    abi: PactRegistryAbi,
    functionName: "pauseProtocol",
    args: [paused],
  });
}

export function encodeTopUp(slug: string, amount: bigint): Hex {
  return encodeFunctionData({
    abi: PactPoolAbi,
    functionName: "topUp",
    args: [asSlugBytes16(slug), amount],
  });
}

export interface SettlementEventInput {
  /** 16-byte call id (raw, not slug-encoded). */
  callId: string;
  agent: Address | string;
  /** Endpoint slug string OR an already-formed bytes16 hex. */
  endpointSlug: string;
  premium: bigint;
  refund: bigint;
  latencyMs: number;
  breach: boolean;
  feeRecipientCountHint: number;
  timestamp: bigint;
}

export function encodeSettleBatch(events: SettlementEventInput[]): Hex {
  return encodeFunctionData({
    abi: PactSettlerAbi,
    functionName: "settleBatch",
    args: [
      events.map((e) => ({
        callId: asBytes16(e.callId),
        agent: asAddress(String(e.agent)),
        endpointSlug: asSlugBytes16(e.endpointSlug),
        premium: e.premium,
        refund: e.refund,
        latencyMs: e.latencyMs,
        breach: e.breach,
        feeRecipientCountHint: e.feeRecipientCountHint,
        timestamp: e.timestamp,
      })),
    ],
  });
}

// SETTLER_ROLE-gated registry hooks (mirrors the IPactRegistry surface;
// included per the GATE-A-approved T4 scope).

export function encodeRecordCallAndCapAccrual(
  slug: string,
  premium: bigint,
  breach: boolean,
  intendedRefund: bigint,
): Hex {
  return encodeFunctionData({
    abi: PactRegistryAbi,
    functionName: "recordCallAndCapAccrual",
    args: [asSlugBytes16(slug), premium, breach, intendedRefund],
  });
}

export function encodeRecordRefundPaid(slug: string, actualRefund: bigint): Hex {
  return encodeFunctionData({
    abi: PactRegistryAbi,
    functionName: "recordRefundPaid",
    args: [asSlugBytes16(slug), actualRefund],
  });
}
