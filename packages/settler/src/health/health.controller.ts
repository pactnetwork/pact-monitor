import { Controller, Get } from "@nestjs/common";
import { PipelineService } from "../pipeline/pipeline.service";

@Controller("health")
export class HealthController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get()
  check() {
    return { status: "ok", lag_ms: this.pipeline.lagMs };
  }
}
