import { Injectable, Logger } from "@nestjs/common";
import { SettleMessage } from "../consumer/consumer.service";

/**
 * Maximum events per batch.
 *
 * **Hard ceiling for v1**: 3. Each event reads ≥7 accounts (callRecord, pool,
 * poolVault, endpoint, agentAta + up to 8 fee-recipient ATAs) plus a 104-byte
 * SettlementEvent payload. With pubkeys serialised inline (no Address Lookup
 * Tables yet), hand-calc of a 5-event tx ≈ 1275 bytes blows past the 1232-
 * byte legacy v0 wire cap once ComputeBudget instructions are included. A
 * 3-event batch fits even with 8 fee recipients per event. Pushing past
 * this risks `Transaction too large` at submit time, which nack-loops the
 * batch on Pub/Sub.
 *
 * Tuning lever for V2: integrate Address Lookup Tables (each pubkey shrinks
 * from 32 bytes to 1 byte) so a 50-event batch fits comfortably. Until then
 * keep this conservative.
 */
export const MAX_BATCH_SIZE = 3;
export const FLUSH_INTERVAL_MS = 5000;

export interface SettleBatch {
  messages: SettleMessage[];
}

@Injectable()
export class BatcherService {
  private readonly logger = new Logger(BatcherService.name);
  private pending: SettleMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onFlush: ((batch: SettleBatch) => Promise<void>) | null = null;

  setFlushCallback(cb: (batch: SettleBatch) => Promise<void>) {
    this.onFlush = cb;
  }

  push(message: SettleMessage): void {
    // Drop zero-premium events at the boundary. The wrap classifier emits
    // `client_error → premium=0, refund=0` events for 4xx upstream failures.
    // The on-chain program rejects events with premium < MIN_PREMIUM_LAMPORTS
    // (=100 lamports) via PremiumTooSmall, which aborts the entire batch.
    // If we let these into a batch, the settler nacks → Pub/Sub redelivers →
    // infinite poison loop. Ack and drop here.
    const data = message.data as Record<string, unknown>;
    const premium = BigInt((data["premiumLamports"] as string) ?? "0");
    if (premium === 0n) {
      this.logger.debug(
        `Skipping zero-premium event ${data["callId"]} outcome=${data["outcome"]}`,
      );
      message.ack();
      return;
    }

    this.pending.push(message);

    if (this.pending.length === 1) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }

    if (this.pending.length >= MAX_BATCH_SIZE) {
      this.cancelTimer();
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.pending.length === 0) return;

    const batch: SettleBatch = { messages: this.pending.splice(0, this.pending.length) };
    this.logger.log(`Flushing batch of ${batch.messages.length} events`);

    if (this.onFlush) {
      await this.onFlush(batch);
    }
  }

  /**
   * Force a final flush during shutdown. Cancels any pending timer and
   * synchronously awaits the flush callback. Caller is responsible for
   * waiting on any in-flight processBatch this triggers.
   */
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
