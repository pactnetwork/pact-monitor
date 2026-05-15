import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@pact-network/db-zerog';

/**
 * Postgres handle for the indexer projection. Connection string is
 * `PG_URL_ZEROG` (resolved by Prisma from env at runtime — see
 * db-zerog/prisma/schema.prisma).
 *
 * Shutdown ordering: the log-reader poller stops + drains its in-flight
 * block `$transaction` in `beforeApplicationShutdown`; this `$disconnect`
 * runs in `onModuleDestroy` (later), so no block write is cut off. Prisma
 * 5.22 dropped the legacy `beforeExit` interference — standard Nest hooks
 * are sufficient.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
