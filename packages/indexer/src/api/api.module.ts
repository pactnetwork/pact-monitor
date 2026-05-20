import { Module } from "@nestjs/common";
import { EndpointsController } from "./endpoints.controller";
import { AgentsController } from "./agents.controller";
import { CallsController } from "./calls.controller";
import { RecipientsController } from "./recipients.controller";

@Module({
  controllers: [
    EndpointsController,
    AgentsController,
    CallsController,
    RecipientsController,
  ],
})
export class ApiModule {}
