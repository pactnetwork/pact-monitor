import { Injectable, Logger } from "@nestjs/common";
import { SettleMessage } from "../consumer/consumer.service";

/**
 * Maximum events per batch.
 *
 * **Hard ceiling for v1**: 5. Each event reads ≥7 accounts (callRecord, pool,
 * poolVault, endpoint, agentAta + up to 8 fee-recipient ATAs) plus a 104-byte
 * SettlementEvent payload. With pubkeys serialised inline (no Address Lookup
 * Tables yet), the legacy v0 1232-byte tx limit caps a realistic 1-3 fee-
 * recipient batch at ~5 events. Pushing past this risks `Transaction too
 * large` at submit time, which nack-loops the batch on Pub/Sub.
 *
 * Tuning lever for V2: integrate Address Lookup Tables (each pubkey shrinks
 * from 32 bytes to 1 byte) so a 50-event batch fits comfortably. Until then
 * keep this conservative.
 */
export const MAX_BATCH_SIZE = 5;
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
