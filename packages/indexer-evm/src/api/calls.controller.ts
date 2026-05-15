import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

/** EVM wire shape of a Call. BigInts → decimal strings (Nest's JSON
 *  serialiser cannot encode bigint). */
interface CallWire {
  callId: string;
  agentAddress: string;
  endpointSlug: string;
  premiumWei: string;
  refundWei: string;
  requestedRefundWei: string;
  latencyMs: number | null;
  breach: boolean;
  breachReason: string | null;
  status: number;
  evidenceRootHash: string;
  source: string | null;
  ts: Date;
  settledAt: Date;
  txHash: string;
  blockNumber: string;
  logIndex: number;
}

interface CallRow {
  callId: string;
  agentAddress: string;
  endpointSlug: string;
  premiumWei: bigint;
  refundWei: bigint;
  requestedRefundWei: bigint;
  latencyMs: number | null;
  breach: boolean;
  breachReason: string | null;
  status: number;
  evidenceRootHash: string;
  source: string | null;
  ts: Date;
  settledAt: Date;
  txHash: string;
  blockNumber: bigint;
  logIndex: number;
}

function serializeCall(r: CallRow): CallWire {
  return {
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
    evidenceRootHash: r.evidenceRootHash,
    source: r.source,
    ts: r.ts,
    settledAt: r.settledAt,
    txHash: r.txHash,
    blockNumber: r.blockNumber.toString(),
    logIndex: r.logIndex,
  };
}

function clampLimit(s?: string): number {
  const n = Number(s);
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : 50, 1), 200);
}

@Controller('api/calls')
export class CallsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listRecent(@Query('limit') limitStr?: string): Promise<CallWire[]> {
    const rows = await this.prisma.call.findMany({
      orderBy: { ts: 'desc' },
      take: clampLimit(limitStr),
    });
    return rows.map(serializeCall);
  }

  @Get(':id')
  async getCall(@Param('id') callId: string) {
    const call = await this.prisma.call.findUnique({ where: { callId } });
    if (!call) throw new NotFoundException(`Call not found: ${callId}`);
    // Re-keyed from Solana `call.signature` → `call.txHash`. Shares are
    // batch-level (all calls in a settleBatch tx share this array).
    const shares = await this.prisma.settlementRecipientShare.findMany({
      where: { settlementTx: call.txHash },
    });
    return {
      ...serializeCall(call),
      recipientShares: shares.map((s) => ({
        kind: s.recipientKind,
        address: s.recipientAddress,
        amountWei: s.amountWei.toString(),
      })),
    };
  }
}
