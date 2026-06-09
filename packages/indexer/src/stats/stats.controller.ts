import { Controller, Get, Query } from "@nestjs/common";
import { StatsService } from "./stats.service";
import { validateNetworkParam } from "../lib/network-filter";

@Controller("api/stats")
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  getStats(@Query("network") rawNetwork?: string) {
    const network = validateNetworkParam(rawNetwork);
    return this.stats.getStats({ network });
  }
}
