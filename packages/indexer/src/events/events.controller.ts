import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PushSecretGuard } from "../guards/push-secret.guard";
import { EventsService } from "./events.service";
import { SettlementEventDto } from "./events.dto";

@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(PushSecretGuard)
  async ingest(@Body() dto: SettlementEventDto) {
    return this.events.ingest(dto);
  }
}
