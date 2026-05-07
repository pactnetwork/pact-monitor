import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/agents")
export class AgentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(":pubkey")
  async getAgent(@Param("pubkey") pubkey: string) {
    const agent = await this.prisma.agent.findUnique({ where: { pubkey } });
    if (!agent) throw new NotFoundException(`Agent not found: ${pubkey}`);
    return agent;
  }

  @Get(":pubkey/calls")
  async getAgentCalls(
    @Param("pubkey") pubkey: string,
    @Query("limit") limitStr?: string,
  ) {
    const limit = Math.min(parseInt(limitStr ?? "50", 10) || 50, 200);
    return this.prisma.call.findMany({
      where: { agentPubkey: pubkey },
      orderBy: { ts: "desc" },
      take: limit,
    });
  }
}
