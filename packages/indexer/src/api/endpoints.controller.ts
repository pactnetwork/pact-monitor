import {
  Controller,
  Get,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Public read API for Endpoint rows.
 *
 * Wire shape (consumed by the dashboard's `lib/api/real.ts -> mapEndpoint`):
 *
 *   - All Endpoint scalar columns (slug, displayName, paused, ...)
 *   - `pool: { currentBalanceLamports, totalPremiumsLamports,
 *              totalRefundsLamports, totalFeesPaidLamports } | null`
 *     materialised from PoolState. `null` when no settlement has hit the
 *     endpoint yet (PoolState rows are lazy-created on first ingest).
 *   - `feeRecipients: []` — the indexer does NOT yet sync the on-chain
 *     `EndpointConfig.fee_recipients` array into the DB. Returned as an
 *     empty array so existing clients keep parsing. A follow-up task must
 *     materialise this from `register_endpoint` / `update_fee_recipients`
 *     log replay; see B-followup task #14.
 *
 * Bigints are serialised as decimal strings, matching the rest of the
 * indexer's wire contract (see stats.service.ts and events.dto.ts).
 */
@Controller("api/endpoints")
export class EndpointsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listEndpoints() {
    const rows = await this.prisma.endpoint.findMany({
      orderBy: { registeredAt: "asc" },
      include: { poolState: true },
    });
    return rows.map((row) => serializeEndpoint(row));
  }

  @Get(":slug")
  async getEndpoint(@Param("slug") slug: string) {
    const endpoint = await this.prisma.endpoint.findUnique({
      where: { slug },
      include: { poolState: true },
    });
    if (!endpoint) throw new NotFoundException(`Endpoint not found: ${slug}`);
    return serializeEndpoint(endpoint);
  }
}

/**
 * Reshape a Prisma Endpoint (with optional joined PoolState) into the
 * dashboard's wire format. BigInt fields are emitted as decimal strings so
 * `JSON.stringify` doesn't crash and the dashboard can parse them with
 * `bigIntStrToNumber`.
 */
function serializeEndpoint(
  row: {
    slug: string;
    flatPremiumLamports: bigint;
    percentBps: number;
    slaLatencyMs: number;
    imputedCostLamports: bigint;
    exposureCapPerHourLamports: bigint;
    paused: boolean;
    upstreamBase: string;
    displayName: string;
    logoUrl: string | null;
    registeredAt: Date;
    lastUpdated: Date;
    poolState?: {
      currentBalanceLamports: bigint;
      totalDepositsLamports: bigint;
      totalPremiumsLamports: bigint;
      totalFeesPaidLamports: bigint;
      totalRefundsLamports: bigint;
      lastUpdated: Date;
    } | null;
  },
) {
  return {
    slug: row.slug,
    flatPremiumLamports: row.flatPremiumLamports.toString(),
    percentBps: row.percentBps,
    slaLatencyMs: row.slaLatencyMs,
    imputedCostLamports: row.imputedCostLamports.toString(),
    exposureCapPerHourLamports: row.exposureCapPerHourLamports.toString(),
    paused: row.paused,
    upstreamBase: row.upstreamBase,
    displayName: row.displayName,
    logoUrl: row.logoUrl,
    registeredAt: row.registeredAt,
    lastUpdated: row.lastUpdated,
    pool: row.poolState
      ? {
          currentBalanceLamports:
            row.poolState.currentBalanceLamports.toString(),
          totalDepositsLamports:
            row.poolState.totalDepositsLamports.toString(),
          totalPremiumsLamports:
            row.poolState.totalPremiumsLamports.toString(),
          totalFeesPaidLamports:
            row.poolState.totalFeesPaidLamports.toString(),
          totalRefundsLamports: row.poolState.totalRefundsLamports.toString(),
          lastUpdated: row.poolState.lastUpdated,
        }
      : null,
    // On-chain registration sync to DB is a follow-up — see controller doc.
    feeRecipients: [] as Array<{
      kind: number;
      pubkey: string;
      bps: number;
    }>,
  };
}
