import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAddress } from 'viem';
import { encodeCallId, MIN_PREMIUM } from '@pact-network/protocol-zerog-client';
import { SettleMessage } from '../consumer/consumer.service';

export const FLUSH_INTERVAL_MS = 5000;
const UINT96_MAX = (1n << 96n) - 1n;
const SETTLED_LRU_CAP = 5000;
/** Slug must be 1..16 printable-ASCII bytes — `PactCore._validateSlug`. */
const SLUG_RE = /^[\x20-\x7E]{1,16}$/;

export interface SettleBatch {
  messages: SettleMessage[];
}

/**
 * Reasons a message is ack'd-and-dropped at the boundary instead of entering a
 * batch. `PactCore.settleBatch` reverts the WHOLE batch on any of these, so
 * letting one through poisons the batch → nack → infinite Pub/Sub redelivery.
 * Drop here, never poison.
 */
export type DropReason =
  | 'malformed_amount'
  | 'premium_too_small'
  | 'amount_overflow'
  | 'invalid_slug'
  | 'invalid_agent'
  | 'invalid_callid'
  | 'duplicate_settled';

@Injectable()
export class BatcherService {
  private readonly logger = new Logger(BatcherService.name);
  private pending: SettleMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onFlush: ((batch: SettleBatch) => Promise<void>) | null = null;
  private readonly maxBatchSize: number;

  /** Best-effort cross-batch dedup. Only callIds CONFIRMED settled on-chain
   *  are added (by the submitter) — a nack-retried *unsettled* batch is not
   *  here, so legitimate redelivery still flows through. */
  private readonly settledLru = new Map<string, 1>();
  private readonly dropped = new Map<DropReason, number>();

  constructor(private readonly config: ConfigService) {
    this.maxBatchSize = this.config.get<number>('MAX_BATCH_SIZE') ?? 10;
  }

  setFlushCallback(cb: (batch: SettleBatch) => Promise<void>) {
    this.onFlush = cb;
  }

  /** Submitter calls this on confirmed settle (and for pre-filtered
   *  already-settled records) so redeliveries are dropped at the boundary. */
  markSettled(callIds: string[]): void {
    for (const id of callIds) {
      this.settledLru.set(id, 1);
      if (this.settledLru.size > SETTLED_LRU_CAP) {
        const oldest = this.settledLru.keys().next().value;
        if (oldest !== undefined) this.settledLru.delete(oldest);
      }
    }
  }

  get droppedCounts(): ReadonlyMap<DropReason, number> {
    return this.dropped;
  }

  private drop(reason: DropReason, m: SettleMessage, detail: string): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
    this.logger.debug(`drop[${reason}] ${detail}`);
    m.raw.ack();
  }

  push(message: SettleMessage): void {
    const d = message.data as Record<string, unknown>;

    let premiumWei: bigint;
    let refundWei: bigint;
    try {
      premiumWei = BigInt((d['premiumLamports'] as string) ?? '0');
      refundWei = BigInt((d['refundLamports'] as string) ?? '0');
    } catch {
      this.drop('malformed_amount', message, String(d['callId']));
      return;
    }

    // Sub-MIN premium (incl. zero-premium client_error events) → whole-batch
    // `PremiumTooSmall` revert (T21).
    if (premiumWei < MIN_PREMIUM) {
      this.drop('premium_too_small', message, `${d['callId']} p=${premiumWei}`);
      return;
    }
    // uint96 fields — viem would throw at encode → poison.
    if (premiumWei > UINT96_MAX || refundWei > UINT96_MAX) {
      this.drop('amount_overflow', message, String(d['callId']));
      return;
    }

    const slug = d['endpointSlug'];
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      this.drop('invalid_slug', message, `${d['callId']} slug=${String(slug)}`);
      return;
    }

    // BLOCKER #3: wrap types agentPubkey as a free string. Pact-0G's contract
    // is that market-proxy-zerog emits a 0x EVM address here. Anything else is
    // dropped, never poisons the batch.
    const agent = d['agentPubkey'];
    if (typeof agent !== 'string' || !isAddress(agent)) {
      this.drop('invalid_agent', message, `${d['callId']} agent=${String(agent)}`);
      return;
    }

    let encodedCallId: string;
    try {
      encodedCallId = encodeCallId(String(d['callId']));
    } catch {
      this.drop('invalid_callid', message, String(d['callId']));
      return;
    }
    if (this.settledLru.has(encodedCallId)) {
      this.drop('duplicate_settled', message, encodedCallId);
      return;
    }

    this.pending.push(message);

    if (this.pending.length === 1) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
    if (this.pending.length >= this.maxBatchSize) {
      this.cancelTimer();
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.pending.length === 0) return;
    const batch: SettleBatch = {
      messages: this.pending.splice(0, this.pending.length),
    };
    this.logger.log(`Flushing batch of ${batch.messages.length} events`);
    if (this.onFlush) {
      await this.onFlush(batch);
    }
  }

  /** Force a final flush during shutdown. */
  async flushNow(): Promise<void> {
    return this.flush();
  }

  private cancelTimer() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
