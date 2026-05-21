import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { EventsModule } from "./events/events.module";
import { StatsModule } from "./stats/stats.module";
import { ApiModule } from "./api/api.module";
import { OpsModule } from "./ops/ops.module";
import { SyncModule } from "./sync/sync.module";
import { AdaptersModule } from "./adapters/adapters.module";
import { ReorgModule } from "./reorg/reorg.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    EventsModule,
    StatsModule,
    ApiModule,
    OpsModule,
    SyncModule,
    AdaptersModule,
    ReorgModule,
  ],
})
export class AppModule {}
