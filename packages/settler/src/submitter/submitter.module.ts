import { Module } from "@nestjs/common";
import { SubmitterService } from "./submitter.service";
import { AppConfigModule } from "../config/config.module";
import { AdaptersModule } from "../adapters/adapters.module";

@Module({
  imports: [AppConfigModule, AdaptersModule],
  providers: [SubmitterService],
  exports: [SubmitterService],
})
export class SubmitterModule {}
