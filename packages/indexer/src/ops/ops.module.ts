import { Module } from "@nestjs/common";
import { OpsController } from "./ops.controller";
import { OpsDisabledInProdGuard } from "./ops-disabled-in-prod.guard";
import { OpsService } from "./ops.service";

@Module({
  controllers: [OpsController],
  providers: [OpsService, OpsDisabledInProdGuard],
})
export class OpsModule {}
