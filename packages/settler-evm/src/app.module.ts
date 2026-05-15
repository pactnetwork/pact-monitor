import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { parseEnv } from './config/env';
import { AppConfigModule } from './config/config.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';

// No IndexerModule — indexer-evm reads CallSettled/RecipientPaid logs directly.
@Module({
  imports: [
    // `validate` runs the zod schema at boot — fail loud on bad config, and
    // expose coerced values (ZEROG_CHAIN_ID:number, MAX_BATCH_SIZE default).
    ConfigModule.forRoot({ isGlobal: true, validate: parseEnv }),
    AppConfigModule,
    PipelineModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
