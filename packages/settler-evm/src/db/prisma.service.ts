import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@pact-network/db-zerog';

/**
 * Postgres handle for the orphan-blob tracker (`FailedSettlement`). The
 * connection string is `PG_URL_ZEROG` (resolved by Prisma from the env at
 * runtime — see db-zerog/prisma/schema.prisma).
 *
 * Lifecycle: `$disconnect` runs in `onModuleDestroy`. Nest invokes destroy
 * hooks after the pipeline's drain (which `await`s its in-flight DB writes),
 * so no `FailedSettlement` row is left half-written on SIGTERM. Prisma 5.22
 * dropped the legacy `beforeExit`/`process.exit` interference, so the standard
 * Nest shutdown hooks are sufficient (no `$on('beforeExit')` workaround).
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

  /** One row per call, written BEFORE the settleBatch tx (orphan = settled:false). */
  async recordOrphans(
    rows: { callId: string; evidenceRootHash: string }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const attemptedAt = new Date();
    await this.failedSettlement.createMany({
      data: rows.map((r) => ({
        callId: r.callId,
        evidenceRootHash: r.evidenceRootHash,
        attemptedAt,
        settled: false,
      })),
    });
  }

  /** On tx success: the blobs are now referenced on-chain — no longer orphans. */
  async markSettled(callIds: string[]): Promise<void> {
    if (callIds.length === 0) return;
    await this.failedSettlement.updateMany({
      where: { callId: { in: callIds }, settled: false },
      data: { settled: true },
    });
  }

  /** On tx revert: leave settled:false, stamp the reason for manual GC. */
  async markFailed(callIds: string[], errorMessage: string): Promise<void> {
    if (callIds.length === 0) return;
    await this.failedSettlement.updateMany({
      where: { callId: { in: callIds }, settled: false },
      data: { errorMessage },
    });
  }
}
