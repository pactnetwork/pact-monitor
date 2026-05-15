import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';

@Controller('api/stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  getStats() {
    return this.stats.getStats();
  }
}
