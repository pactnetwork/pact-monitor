import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// BigInts must be stringified at the controller boundary because Nest's default
// JSON serialiser cannot encode `bigint` (TypeError on JSON.stringify). Same
// pattern as calls.controller.ts / endpoints.controller.ts.
interface AgentWire {
  pubkey: string;
  displayName: string | null;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  callCount: string;
  lastCallAt: Date | null;
  createdAt: Date;
}

interface AgentRow {
  pubkey: string;
  displayName: string | null;
  totalPremiumsLamports: bigint;
  totalRefundsLamports: bigint;
  callCount: bigint;
  lastCallAt: Date | null;
  createdAt: Date;
}

function serializeAgent(row: AgentRow): AgentWire {
  return {
    pubkey: row.pubkey,
    displayName: row.displayName,
    totalPremiumsLamports: row.totalPremiumsLamports.toString(),
    totalRefundsLamports: row.totalRefundsLamports.toString(),
    callCount: row.callCount.toString(),
    lastCallAt: row.lastCallAt,
    createdAt: row.createdAt,
  };
}

interface AgentCallWire {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  latencyMs: number;
  breach: boolean;
  breachReason: string | null;
  source: string | null;
  ts: Date;
  settledAt: Date;
  signature: string;
}

interface AgentCallRow extends Omit<AgentCallWire, "premiumLamports" | "refundLamports"> {
  premiumLamports: bigint;
  refundLamports: bigint;
}

function serializeCall(row: AgentCallRow): AgentCallWire {
  return {
    callId: row.callId,
    agentPubkey: row.agentPubkey,
    endpointSlug: row.endpointSlug,
    premiumLamports: row.premiumLamports.toString(),
    refundLamports: row.refundLamports.toString(),
    latencyMs: row.latencyMs,
    breach: row.breach,
    breachReason: row.breachReason,
    source: row.source,
    ts: row.ts,
    settledAt: row.settledAt,
    signature: row.signature,
  };
}

@Controller("api/agents")
export class AgentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(":pubkey")
  async getAgent(@Param("pubkey") pubkey: string): Promise<AgentWire> {
    const agent = await this.prisma.agent.findUnique({ where: { pubkey } });
    if (!agent) throw new NotFoundException(`Agent not found: ${pubkey}`);
    return serializeAgent(agent);
  }

  @Get(":pubkey/calls")
  async getAgentCalls(
    @Param("pubkey") pubkey: string,
    @Query("limit") limitStr?: string,
  ): Promise<AgentCallWire[]> {
    const parsed = Number(limitStr);
    const limit = Math.min(
      Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 50, 1),
      200,
    );
    const rows = await this.prisma.call.findMany({
      where: { agentPubkey: pubkey },
      orderBy: { ts: "desc" },
      take: limit,
    });
    return rows.map(serializeCall);
  }
}
