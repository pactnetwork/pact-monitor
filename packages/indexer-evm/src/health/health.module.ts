import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DbModule } from '../db/db.module';
import { ReaderModule } from '../reader/reader.module';

@Module({
  imports: [DbModule, ReaderModule],
  controllers: [HealthController],
})
export class HealthModule {}
