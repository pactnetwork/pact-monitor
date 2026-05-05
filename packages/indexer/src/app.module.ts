import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { EventsModule } from "./events/events.module";
import { StatsModule } from "./stats/stats.module";
import { ApiModule } from "./api/api.module";
import { OpsModule } from "./ops/ops.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    EventsModule,
    StatsModule,
    ApiModule,
    OpsModule,
  ],
})
export class AppModule {}
