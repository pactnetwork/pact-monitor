import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppConfigModule } from "./config/config.module";
import { PipelineModule } from "./pipeline/pipeline.module";
import { HealthModule } from "./health/health.module";
import { MetricsModule } from "./metrics/metrics.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AppConfigModule,
    PipelineModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
