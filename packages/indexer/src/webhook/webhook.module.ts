import { Module } from "@nestjs/common";
import { WebhookController } from "./webhook.controller";
import { WebhookParserService } from "./parser.service";

@Module({
  controllers: [WebhookController],
  providers: [WebhookParserService],
})
export class WebhookModule {}
