import { Module } from "@nestjs/common";
import { SubmitterService } from "./submitter.service";
import { AppConfigModule } from "../config/config.module";

@Module({
  imports: [AppConfigModule],
  providers: [SubmitterService],
  exports: [SubmitterService],
})
export class SubmitterModule {}
