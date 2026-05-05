import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Counter, Gauge, Histogram, register } from "prom-client";
import { ConsumerService } from "../consumer/consumer.service";
import { BatcherService, SettleBatch } from "../batcher/batcher.service";
import { SubmitterService, BatchSubmitError } from "../submitter/submitter.service";
import { IndexerPusherService } from "../indexer/indexer-pusher.service";

@Injectable()
export class PipelineService implements OnModuleInit {
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
      this.batcher.push(msg);
      this.queueLagGauge.set(this.consumer.queueLength);
    });

    this.batcher.setFlushCallback(async (batch) => {
      await this.processBatch(batch);
    });
  }

  private async processBatch(batch: SettleBatch): Promise<void> {
    const start = Date.now();
    this.batchSizeHist.observe(batch.messages.length);

    let signature: string;
    try {
      signature = await this.submitter.submit(batch);
    } catch (err) {
      if (err instanceof BatchSubmitError) {
        this.txFailuresCounter.inc();
        this.logger.error(`Batch submit failed permanently, nacking ${batch.messages.length} messages: ${err.message}`);
        this.consumer.nack(batch.messages);
        return;
      }
      throw err;
    }

    this.lastSuccessAt = Date.now();
    this.batchDurationHist.observe(Date.now() - start);

    await this.indexerPusher.push(signature, batch);
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
