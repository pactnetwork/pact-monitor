import { Module } from '@nestjs/common';
import { SubmitterService } from './submitter.service';
import { AppConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { BatcherModule } from '../batcher/batcher.module';
import { ChainModule } from '../chain/chain.module';

@Module({
  imports: [AppConfigModule, DbModule, BatcherModule, ChainModule],
  providers: [SubmitterService],
  exports: [SubmitterService],
})
export class SubmitterModule {}
