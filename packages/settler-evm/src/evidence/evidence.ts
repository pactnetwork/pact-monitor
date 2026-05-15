/**
 * Canonical per-call evidence blob.
 *
 * 0G Storage is content-addressed: identical bytes → identical rootHash. The
 * settler relies on this for idempotent retries — re-uploading the same
 * evidence after a reverted `settleBatch` yields the same rootHash, so an
 * orphaned blob is never duplicated. That guarantee only holds if the blob is
 * byte-stable, so this builder fixes key order and the BigInt encoding rather
 * than trusting `JSON.stringify` over an ad-hoc object.
 */

import type { Outcome } from '@pact-network/wrap';

export interface EvidenceInput {
  /** Original event call id (UUID or 32-hex form), human-readable. */
  callId: string;
  /** Resolved EVM agent address (0x, checksummed or lower — caller decides). */
  agent: string;
  endpointSlug: string;
  premiumWei: bigint;
  refundWei: bigint;
  latencyMs: number;
  outcome: Outcome;
  breach: boolean;
  /** ISO-8601 timestamp from the SettlementEvent. */
  ts: string;
}

/**
 * Produce the canonical JSON string. Keys are emitted in this exact order;
 * BigInts become decimal strings. No `JSON.stringify` replacer is used so the
 * output cannot drift if the input object carries extra keys.
 */
export function canonicalEvidenceJson(input: EvidenceInput): string {
  const ordered = {
    callId: input.callId,
    agent: input.agent,
    endpointSlug: input.endpointSlug,
    premiumWei: input.premiumWei.toString(),
    refundWei: input.refundWei.toString(),
    latencyMs: input.latencyMs,
    outcome: input.outcome,
    breach: input.breach,
    ts: input.ts,
  };
  return JSON.stringify(ordered);
}

/** UTF-8 bytes of the canonical JSON — the exact blob uploaded to 0G Storage. */
export function buildEvidenceBlob(input: EvidenceInput): Uint8Array {
  return new TextEncoder().encode(canonicalEvidenceJson(input));
}
