import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Wire-shape mirror of a Prisma `Call` row, with BigInt fields emitted as
 * decimal strings — matches the dashboard's `IndexerCall` interface in
 * `packages/market-dashboard/lib/api/real.ts`.
 *
 * BigInts must be stringified at the controller boundary because Nest's
 * default JSON serialiser cannot encode `bigint` (TypeError on JSON.stringify).
 * Other indexer services follow the same pattern; see stats.service.ts.
 */
interface CallWire {
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

interface CallRow extends Omit<CallWire, "premiumLamports" | "refundLamports"> {
  premiumLamports: bigint;
  refundLamports: bigint;
}

function serializeCall(row: CallRow): CallWire {
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

/**
 * Public read API for Call rows.
 *
 * Wire-shape contract for the dashboard's `lib/api/real.ts`:
 *
 *   GET /api/calls?limit=N
 *     -> Array<CallWire> ordered by `ts` DESC, capped at 200.
 *        Default limit is 50. Backs the homepage "Recent Events" firehose.
 *
 *   GET /api/calls/:id
 *     -> CallWire for a single call.
 */
@Controller("api/calls")
export class CallsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recent calls firehose. Backs the dashboard's "Recent Events" panel via
   * `fetchCalls()` in `lib/api/real.ts`. Returns at most `limit` calls
   * ordered by `ts` DESC. Limit is clamped to [1, 200] with a default of 50.
   */
  @Get()
  async listRecent(@Query("limit") limitStr?: string): Promise<CallWire[]> {
    const parsed = Number(limitStr);
    const limit = Math.min(
      Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 50, 1),
      200,
    );
    const rows = await this.prisma.call.findMany({
      orderBy: { ts: "desc" },
      take: limit,
    });
    return rows.map(serializeCall);
  }

  @Get(":id")
  async getCall(@Param("id") callId: string): Promise<CallWire> {
    const call = await this.prisma.call.findUnique({ where: { callId } });
    if (!call) throw new NotFoundException(`Call not found: ${callId}`);
    return serializeCall(call);
  }
}
