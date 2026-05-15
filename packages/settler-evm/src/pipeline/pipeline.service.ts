import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Counter, Gauge, Histogram, register } from 'prom-client';
import { ConsumerService } from '../consumer/consumer.service';
import { BatcherService, SettleBatch } from '../batcher/batcher.service';
import { SubmitterService } from '../submitter/submitter.service';

/**
 * Wires consumer → batcher → submitter and owns ack/nack.
 *
 * STRICTLY SEQUENTIAL (BLOCKER #1): unlike the Solana settler's concurrent
 * `inflightBatches` Set, batches are processed one at a time via a single
 * promise chain. The settle tx (viem) and the per-event 0G Storage uploads
 * (ethers) sign with the SAME EOA; overlapping batches would race the nonce.
 * The submitter's `SigningMutex` serializes individual signs; this chain
 * guarantees whole batches never overlap.
 *
 * No indexer push: `indexer-evm` reads `CallSettled`/`RecipientPaid` logs
 * from chain directly. The settler's only side effects are the on-chain tx
 * and the `FailedSettlement` orphan rows (written by the submitter).
 */
@Injectable()
export class PipelineService implements OnModuleInit, OnModuleDestroy {
  private tail: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private readonly logger = new Logger(PipelineService.name);
  private lastSuccessAt: number | null = null;

  private readonly batchSizeHist: Histogram;
  private readonly batchDurationHist: Histogram;
  private readonly queueLagGauge: Gauge;
  private readonly txFailuresCounter: Counter;

  constructor(
    private readonly consumer: ConsumerService,
    private readonly batcher: BatcherService,
    private readonly submitter: SubmitterService,
  ) {
    const reuse = <T>(name: string, make: () => T): T =>
      (register.getSingleMetric(name) as T | undefined) ?? make();
    this.batchSizeHist = reuse(
      'settler_evm_batch_size',
      () =>
        new Histogram({
          name: 'settler_evm_batch_size',
          help: 'Events per settled batch',
          buckets: [1, 5, 10, 25, 50],
        }),
    );
    this.batchDurationHist = reuse(
      'settler_evm_batch_duration_ms',
      () =>
        new Histogram({
          name: 'settler_evm_batch_duration_ms',
          help: 'Time to process a batch in ms',
          buckets: [100, 500, 1000, 5000, 20000, 60000],
        }),
    );
    this.queueLagGauge = reuse(
      'settler_evm_queue_lag',
      () =>
        new Gauge({
          name: 'settler_evm_queue_lag',
          help: 'Messages pending in the consumer queue',
        }),
    );
    this.txFailuresCounter = reuse(
      'settler_evm_tx_failures_total',
      () =>
        new Counter({
          name: 'settler_evm_tx_failures_total',
          help: 'Batches that ended with at least one nacked message',
        }),
    );
  }

  onModuleInit() {
    this.consumer.setEnqueueCallback((msg) => {
      if (this.shuttingDown) {
        this.logger.warn(`Dropping message during shutdown: ${msg.id}`);
        return;
      }
      this.batcher.push(msg);
      this.queueLagGauge.set(this.consumer.queueLength);
    });

    this.batcher.setFlushCallback((batch) => this.enqueueBatch(batch));
  }

  /** Chain each batch onto the tail so only one runs at a time. Returns the
   *  promise the batcher awaits, so a new flush can't start mid-batch. */
  private enqueueBatch(batch: SettleBatch): Promise<void> {
    const next = this.tail.then(
      () => this.processBatch(batch),
      () => this.processBatch(batch),
    );
    this.tail = next;
    return next;
  }

  private async processBatch(batch: SettleBatch): Promise<void> {
    const start = Date.now();
    this.batchSizeHist.observe(batch.messages.length);
    try {
      const result = await this.submitter.submit(batch);
      if (result.toAck.length > 0) this.consumer.ack(result.toAck);
      if (result.toNack.length > 0) {
        this.txFailuresCounter.inc();
        this.consumer.nack(result.toNack);
      }
      if (result.txHash || result.toAck.length > 0) {
        this.lastSuccessAt = Date.now();
      }
    } catch (err) {
      // RPC/unknown — the submitter classifies known reverts internally and
      // returns toNack; reaching here means an unexpected throw. Nack the
      // whole batch for redelivery.
      this.txFailuresCounter.inc();
      this.logger.error(
        `Unexpected submit error, nacking ${batch.messages.length}: ${String(err)}`,
      );
      this.consumer.nack(batch.messages);
    } finally {
      this.batchDurationHist.observe(Date.now() - start);
      this.queueLagGauge.set(this.consumer.queueLength);
    }
  }

  /**
   * SIGTERM (Cloud Run 10s grace):
   *   1. stop accepting new messages,
   *   2. force a final batcher flush,
   *   3. await the in-flight chain so no settled-but-unacked batch is left
   *      (which would poison-loop on redelivery), and the submitter's awaited
   *      `FailedSettlement` writes complete before Prisma `$disconnect`.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.logger.log('Pipeline shutting down — flushing + draining');
    try {
      await this.batcher.flushNow();
    } catch (err) {
      this.logger.error(`Final batcher flush failed: ${String(err)}`);
    }
    await this.tail.catch(() => undefined);
    this.logger.log('Pipeline drained.');
  }

  get lagMs(): number | null {
    if (this.lastSuccessAt === null) return null;
    return Date.now() - this.lastSuccessAt;
  }

  async metricsText(): Promise<string> {
    return register.metrics();
  }
}
