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
import { EventEmitter } from "node:events";

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

export class PactEventEmitter {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many independent listeners (one per concern) are normal here.
    this.emitter.setMaxListeners(50);
  }

  on<K extends PactEventName>(
    event: K,
    listener: (...args: PactEventMap[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends PactEventName>(
    event: K,
    listener: (...args: PactEventMap[K]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends PactEventName>(event: K, ...args: PactEventMap[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
