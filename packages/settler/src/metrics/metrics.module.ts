import { Module } from "@nestjs/common";
import { MetricsController } from "./metrics.controller";
import { PipelineModule } from "../pipeline/pipeline.module";

@Module({
  imports: [PipelineModule],
  controllers: [MetricsController],
})
export class MetricsModule {}
