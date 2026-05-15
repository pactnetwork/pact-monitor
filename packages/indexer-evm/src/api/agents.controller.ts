import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

interface AgentWire {
  address: string;
  displayName: string | null;
  totalPremiumsWei: string;
  totalRefundsWei: string;
  callCount: string;
  lastCallAt: Date | null;
  createdAt: Date;
}

function serializeAgent(r: {
  address: string;
  displayName: string | null;
  totalPremiumsWei: bigint;
  totalRefundsWei: bigint;
  callCount: bigint;
  lastCallAt: Date | null;
  createdAt: Date;
}): AgentWire {
  return {
    address: r.address,
    displayName: r.displayName,
    totalPremiumsWei: r.totalPremiumsWei.toString(),
    totalRefundsWei: r.totalRefundsWei.toString(),
    callCount: r.callCount.toString(),
    lastCallAt: r.lastCallAt,
    createdAt: r.createdAt,
  };
}

function clampLimit(s?: string): number {
  const n = Number(s);
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : 50, 1), 200);
}

@Controller('api/agents')
export class AgentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':address')
  async getAgent(@Param('address') address: string): Promise<AgentWire> {
    const agent = await this.prisma.agent.findUnique({ where: { address } });
    if (!agent) throw new NotFoundException(`Agent not found: ${address}`);
    return serializeAgent(agent);
  }

  @Get(':address/calls')
  async getAgentCalls(
    @Param('address') address: string,
    @Query('limit') limitStr?: string,
  ) {
    const rows = await this.prisma.call.findMany({
      where: { agentAddress: address },
      orderBy: { ts: 'desc' },
      take: clampLimit(limitStr),
    });
    return rows.map((r) => ({
      callId: r.callId,
      agentAddress: r.agentAddress,
      endpointSlug: r.endpointSlug,
      premiumWei: r.premiumWei.toString(),
      refundWei: r.refundWei.toString(),
      requestedRefundWei: r.requestedRefundWei.toString(),
      latencyMs: r.latencyMs,
      breach: r.breach,
      breachReason: r.breachReason,
      status: r.status,
      ts: r.ts,
      settledAt: r.settledAt,
      txHash: r.txHash,
    }));
  }
}
