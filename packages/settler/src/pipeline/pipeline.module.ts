import { Module } from "@nestjs/common";
import { PipelineService } from "./pipeline.service";
import { ConsumerModule } from "../consumer/consumer.module";
import { BatcherModule } from "../batcher/batcher.module";
import { SubmitterModule } from "../submitter/submitter.module";
import { IndexerModule } from "../indexer/indexer.module";

@Module({
  imports: [ConsumerModule, BatcherModule, SubmitterModule, IndexerModule],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
