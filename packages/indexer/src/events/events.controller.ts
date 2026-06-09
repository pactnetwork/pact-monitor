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
    // WP-MN-03a: default to solana-devnet for legacy unstamped events.
    // Per call resolution: per-call > batch > "solana-devnet".
    const batchNetwork = dto.network ?? "solana-devnet";
    return this.events.ingest({
      ...dto,
      network: batchNetwork,
      calls: dto.calls.map((c) => ({
        ...c,
        network: c.network ?? dto.network ?? "solana-devnet",
      })),
    });
  }
}
