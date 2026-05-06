import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Counter, Gauge, Histogram, register } from "prom-client";
import { ConsumerService } from "../consumer/consumer.service";
import { BatcherService, SettleBatch } from "../batcher/batcher.service";
import { SubmitterService, BatchSubmitError } from "../submitter/submitter.service";
import { IndexerPusherService, IndexerPushError } from "../indexer/indexer-pusher.service";

@Injectable()
export class PipelineService implements OnModuleInit, OnModuleDestroy {
  private inflightBatches = new Set<Promise<void>>();
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
    private readonly indexerPusher: IndexerPusherService
  ) {
    this.batchSizeHist = new Histogram({
      name: "settler_batch_size",
      help: "Number of events per settled batch",
      buckets: [1, 5, 10, 25, 50],
    });
    this.batchDurationHist = new Histogram({
      name: "settler_batch_duration_ms",
      help: "Time to settle a batch in ms",
      buckets: [100, 500, 1000, 3000, 10000],
    });
    this.queueLagGauge = new Gauge({
      name: "settler_queue_lag",
      help: "Number of messages pending in consumer queue",
    });
    this.txFailuresCounter = new Counter({
      name: "settler_tx_failures_total",
      help: "Total number of failed batch submit attempts",
    });
  }

  onModuleInit() {
    this.consumer.setEnqueueCallback((msg) => {
      // Stop accepting new messages once we're shutting down — the consumer
      // will keep them in-flight on Pub/Sub until they ack-deadline expires
      // and Pub/Sub redelivers to the next instance.
      if (this.shuttingDown) {
        this.logger.warn(`Dropping message during shutdown: ${msg.id}`);
        return;
      }
      this.batcher.push(msg);
      this.queueLagGauge.set(this.consumer.queueLength);
    });

    this.batcher.setFlushCallback(async (batch) => {
      await this.runTrackedBatch(batch);
    });
  }

  /**
   * Cloud Run gives a 10s grace on SIGTERM. We:
   *   1. Stop accepting new messages (any newly-enqueued messages get dropped
   *      and Pub/Sub will redeliver them to the next instance).
   *   2. Force-flush the batcher's pending buffer one last time.
   *   3. Await all in-flight processBatch promises so we don't leave a
   *      settled-on-chain-but-not-acked batch hanging (which would poison-
   *      loop on Pub/Sub redelivery).
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.logger.log("Pipeline shutting down — flushing batcher + draining in-flight");

    // Force a final flush of any pending messages.
    try {
      await this.batcher.flushNow?.();
    } catch (err) {
      this.logger.error(`Final batcher flush failed: ${err}`);
    }

    // Drain in-flight batches.
    if (this.inflightBatches.size > 0) {
      this.logger.log(`Awaiting ${this.inflightBatches.size} in-flight batches`);
      await Promise.allSettled(Array.from(this.inflightBatches));
    }

    this.logger.log("Pipeline drained.");
  }

  private async runTrackedBatch(batch: SettleBatch): Promise<void> {
    const p = this.processBatch(batch);
    this.inflightBatches.add(p);
    try {
      await p;
    } finally {
      this.inflightBatches.delete(p);
    }
  }

  private async processBatch(batch: SettleBatch): Promise<void> {
    const start = Date.now();
    this.batchSizeHist.observe(batch.messages.length);

    let outcome;
    try {
      outcome = await this.submitter.submit(batch);
    } catch (err) {
      if (err instanceof BatchSubmitError) {
        this.txFailuresCounter.inc();
        this.logger.error(`Batch submit failed permanently, nacking ${batch.messages.length} messages: ${err.message}`);
        // Submit failure could be due to stale EndpointConfig/Treasury cache
        // (e.g. update_fee_recipients ran since last cache load and the
        // recipient ATAs don't match on-chain). Invalidate the affected slugs
        // so the next batch fetches fresh.
        try {
          this.submitter.invalidateCacheForBatch(batch);
        } catch (invErr) {
          this.logger.warn(`Cache invalidation after submit failure failed: ${invErr}`);
        }
        this.consumer.nack(batch.messages);
        return;
      }
      throw err;
    }

    this.lastSuccessAt = Date.now();
    this.batchDurationHist.observe(Date.now() - start);

    // Push to indexer. If this fails permanently the batch already settled
    // on-chain — we nack so Pub/Sub redelivers and the indexer pusher gets
    // another chance. The submitter's idempotency-on-retry path will see the
    // CallRecord PDAs already exist and short-circuit to the prior signature
    // rather than re-submitting.
    try {
      await this.indexerPusher.push(outcome, batch);
    } catch (err) {
      if (err instanceof IndexerPushError) {
        this.logger.error(
          `Indexer push failed permanently for tx ${outcome.signature}; nacking ${batch.messages.length} messages for redelivery: ${err.message}`,
        );
        this.consumer.nack(batch.messages);
        return;
      }
      throw err;
    }

    this.consumer.ack(batch.messages);
    this.queueLagGauge.set(this.consumer.queueLength);
  }

  get lagMs(): number | null {
    if (this.lastSuccessAt === null) return null;
    return Date.now() - this.lastSuccessAt;
  }

  async metricsText(): Promise<string> {
    return register.metrics();
  }
}
