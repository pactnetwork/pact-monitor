import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { OnChainSyncService } from "./on-chain-sync.service";

/**
 * Wires up the on-chain → DB sync service. The PrismaModule is `@Global()`
 * (see prisma/prisma.module.ts) so we don't re-import it here. ScheduleModule
 * must be imported once in the app to enable `@Cron`-decorated handlers.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [OnChainSyncService],
  exports: [OnChainSyncService],
})
export class SyncModule {}
