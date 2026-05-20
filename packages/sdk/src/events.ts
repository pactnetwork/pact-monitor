/**
 * Typed event surface.
 *
 *  - `failure`     fires immediately from the X-Pact-Outcome response header
 *                  when a covered call is classified non-`ok`.
 *  - `billed`      fires from the indexer poller once the premium is settled
 *                  on-chain (the settled truth, not the provisional header).
 *  - `refund`      fires from the indexer poller once a breach refund lands.
 *  - `low-balance` fires from the auto-top-up watcher.
 *  - `degraded`    fires whenever a call fell back to a bare fetch.
 *
 * `pool-created` from the design draft is intentionally absent — V1 has no
 * agent-side provisioning.
 */
export interface FailureEvent {
  callId: string | null;
  slug: string;
  url: string;
  outcome: string;
  premiumLamports: bigint | null;
  refundLamports: bigint | null;
  ts: string;
}

export interface RefundEvent {
  callId: string;
  slug: string;
  refundLamports: bigint;
  settledAt: Date;
  txSignature: string;
}

export interface BilledEvent {
  callId: string;
  slug: string;
  premiumLamports: bigint;
  settledAt: Date;
  txSignature: string;
}

export interface LowBalanceEvent {
  allowanceLamports: bigint;
  ataBalanceLamports: bigint;
  thresholdLamports: bigint;
}

export interface DegradedEvent {
  reason: string;
  url: string;
  ts: string;
}

export interface PactEventMap {
  failure: [FailureEvent];
  refund: [RefundEvent];
  billed: [BilledEvent];
  "low-balance": [LowBalanceEvent];
  degraded: [DegradedEvent];
}

export type PactEventName = keyof PactEventMap;

type AnyListener = (...args: unknown[]) => void;

/**
 * Minimal typed event emitter — isomorphic (no `node:events`, works in the
 * browser) and strictly better-typed than the old `as unknown[]` casts.
 *
 * A faulting user listener MUST NOT break the golden-rule path that emits
 * `degraded`/`failure` (Node's `EventEmitter.emit` would rethrow), so each
 * listener is invoked in its own try/catch and a throw is swallowed.
 */
export class PactEventEmitter {
  private readonly map = new Map<PactEventName, Set<AnyListener>>();

  on<K extends PactEventName>(
    event: K,
    listener: (...args: PactEventMap[K]) => void,
  ): this {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(listener as AnyListener);
    return this;
  }

  off<K extends PactEventName>(
    event: K,
    listener: (...args: PactEventMap[K]) => void,
  ): this {
    this.map.get(event)?.delete(listener as AnyListener);
    return this;
  }

  emit<K extends PactEventName>(event: K, ...args: PactEventMap[K]): boolean {
    const set = this.map.get(event);
    if (!set || set.size === 0) return false;
    // Copy so a listener that on()/off()s mid-emit can't mutate the iteration.
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch {
        // A listener fault never escapes the emit (golden rule).
      }
    }
    return true;
  }

  removeAllListeners(): void {
    this.map.clear();
  }
}
