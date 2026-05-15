import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { parseEnv } from './config/env';
import { DbModule } from './db/db.module';
import { ChainModule } from './chain/chain.module';
import { ProjectionModule } from './projection/projection.module';
import { ReaderModule } from './reader/reader.module';
import { ApiModule } from './api/api.module';
import { StatsModule } from './stats/stats.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: parseEnv }),
    DbModule,
    ChainModule,
    ProjectionModule,
    ReaderModule,
    ApiModule,
    StatsModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
