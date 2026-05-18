/**
 * Storage abstraction for the durable observation buffer.
 *
 * The covered-call durability guarantee (append BEFORE network I/O, resume on
 * startup, idempotent reconcile) is the SAME across environments; only the
 * backing store differs: `FsObservationBuffer` (Node JSONL, the default) vs
 * `MemoryStorage` (browser / serverless). Both implement `PactStorage`; the
 * aggregation is shared here so there is one source of truth and one coverage
 * target. `selectStorage()` picks the impl at runtime.
 */
export interface PendingObservation {
  callId: string;
  agentPubkey: string;
  slug: string;
  host: string;
  /** ISO-8601 of the agent's outbound call. */
  ts: string;
  /** Provisional value from the X-Pact-Premium response header. */
  premiumLamports: string | null;
  refundLamports: string | null;
  outcome: string | null;
  breach: boolean | null;
  reconciled: boolean;
}

export interface ObservationStats {
  totalCalls: number;
  reconciledCalls: number;
  pendingCalls: number;
  totalPremiumLamportsObserved: bigint;
  totalRefundLamportsObserved: bigint;
  bySlug: Record<string, { calls: number; breaches: number }>;
}

export interface PactStorage {
  /** Durable append — call this BEFORE any reconciliation I/O. */
  append(obs: PendingObservation): void;
  /** Not-yet-settled observations (resume set on startup). */
  loadPending(): PendingObservation[];
  /** Idempotent: only flips a pending row; a no-op once reconciled. */
  markReconciled(callId: string): void;
  stats(): ObservationStats;
}

export function safeBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Pure aggregation shared by every PactStorage impl. */
export function aggregate(all: PendingObservation[]): ObservationStats {
  let premium = 0n;
  let refund = 0n;
  let reconciled = 0;
  const bySlug: Record<string, { calls: number; breaches: number }> = {};
  for (const o of all) {
    if (o.reconciled) reconciled++;
    if (o.premiumLamports) premium += safeBig(o.premiumLamports);
    if (o.refundLamports) refund += safeBig(o.refundLamports);
    const s = (bySlug[o.slug] ??= { calls: 0, breaches: 0 });
    s.calls++;
    if (o.breach) s.breaches++;
  }
  return {
    totalCalls: all.length,
    reconciledCalls: reconciled,
    pendingCalls: all.length - reconciled,
    totalPremiumLamportsObserved: premium,
    totalRefundLamportsObserved: refund,
    bySlug,
  };
}
