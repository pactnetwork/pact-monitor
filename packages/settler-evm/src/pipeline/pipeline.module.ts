import { Module } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { ConsumerModule } from '../consumer/consumer.module';
import { BatcherModule } from '../batcher/batcher.module';
import { SubmitterModule } from '../submitter/submitter.module';

// No IndexerModule — indexer-evm reads CallSettled/RecipientPaid logs directly.
@Module({
  imports: [ConsumerModule, BatcherModule, SubmitterModule],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
