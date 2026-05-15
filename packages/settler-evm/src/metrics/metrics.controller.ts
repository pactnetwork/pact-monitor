import { Controller, Get, Header } from '@nestjs/common';
import { PipelineService } from '../pipeline/pipeline.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    return this.pipeline.metricsText();
  }
}
