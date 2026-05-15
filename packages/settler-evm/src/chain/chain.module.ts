import { Module } from '@nestjs/common';
import { SigningMutex } from './chain';

@Module({
  providers: [SigningMutex],
  exports: [SigningMutex],
})
export class ChainModule {}
