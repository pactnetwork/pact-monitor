/**
 * ReorgModule — wires up ReorgService (WP-MN-04 T3).
 *
 * PrismaModule is @Global() (see prisma/prisma.module.ts), so PrismaService
 * does not need to be re-imported here. AdaptersModule must be imported to
 * pull in AdaptersService for the canonical-chain tail.
 */
import { Module } from "@nestjs/common";
import { AdaptersModule } from "../adapters/adapters.module";
import { ReorgService } from "./reorg.service";

@Module({
  imports: [AdaptersModule],
  providers: [ReorgService],
  exports: [ReorgService],
})
export class ReorgModule {}
