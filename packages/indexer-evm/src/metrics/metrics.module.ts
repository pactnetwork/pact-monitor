import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { ReaderModule } from '../reader/reader.module';

@Module({
  imports: [ReaderModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}
