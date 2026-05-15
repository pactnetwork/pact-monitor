import { Injectable, OnModuleInit } from '@nestjs/common';
import { Gauge, register } from 'prom-client';
import { LogReaderService } from '../reader/log-reader.service';

/**
 * Pull-based metrics. `indexer_evm_last_processed_block` is the headline
 * health signal — a flat line means the tail loop stalled. Gauge `collect`
 * reads the reader's in-memory cursor (no async/DB in the scrape path).
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  constructor(private readonly reader: LogReaderService) {}

  onModuleInit(): void {
    if (register.getSingleMetric('indexer_evm_last_processed_block')) return;
    const reader = this.reader;
    new Gauge({
      name: 'indexer_evm_last_processed_block',
      help: 'Highest block the indexer has scanned to (tail progress).',
      collect() {
        this.set(Number(reader.lastProcessed));
      },
    });
  }

  metrics(): Promise<string> {
    return register.metrics();
  }
}
