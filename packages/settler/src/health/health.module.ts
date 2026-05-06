import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PipelineModule } from "../pipeline/pipeline.module";

@Module({
  imports: [PipelineModule],
  controllers: [HealthController],
})
export class HealthModule {}
