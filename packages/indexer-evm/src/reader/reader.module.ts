import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LogReaderService } from './log-reader.service';
import { ChainModule } from '../chain/chain.module';
import { DbModule } from '../db/db.module';
import { ProjectionModule } from '../projection/projection.module';

@Module({
  imports: [ConfigModule, ChainModule, DbModule, ProjectionModule],
  providers: [LogReaderService],
  exports: [LogReaderService],
})
export class ReaderModule {}
