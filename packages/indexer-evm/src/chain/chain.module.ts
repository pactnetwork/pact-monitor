import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { createReadClients, type ReadClients } from './chain';

export const READ_CLIENTS = 'READ_CLIENTS';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: READ_CLIENTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ReadClients =>
        createReadClients({
          chainId: config.getOrThrow<number>('ZEROG_CHAIN_ID'),
          rpcUrl: config.getOrThrow<string>('ZEROG_RPC_URL'),
          pactCoreAddress: config.getOrThrow<string>(
            'PACT_CORE_ADDRESS',
          ) as `0x${string}`,
        }),
    },
  ],
  exports: [READ_CLIENTS],
})
export class ChainModule {}
