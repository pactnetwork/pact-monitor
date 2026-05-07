import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { HealthController } from "./health.controller";
import { SignerBalanceService } from "./signer-balance.service";
import { PipelineModule } from "../pipeline/pipeline.module";
import { AppConfigModule } from "../config/config.module";

@Module({
  imports: [
    // ScheduleModule.forRoot() is needed once per app for @Cron decorators.
    // The indexer also calls forRoot() but lives in a separate Nest app, so
    // there is no double-registration risk here.
    ScheduleModule.forRoot(),
    PipelineModule,
    AppConfigModule,
  ],
  controllers: [HealthController],
  providers: [SignerBalanceService],
  exports: [SignerBalanceService],
})
export class HealthModule {}
