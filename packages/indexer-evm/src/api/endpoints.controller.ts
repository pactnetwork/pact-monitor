import {
  Controller,
  Get,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

type EndpointRow = {
  slug: string;
  agentTokenId: string;
  flatPremiumWei: bigint;
  percentBps: number;
  imputedCostWei: bigint;
  latencySloMs: number;
  exposureCapPerHourWei: bigint;
  paused: boolean;
  upstreamModel: string | null;
  upstreamProvider: string | null;
  upstreamEndpoint: string | null;
  displayName: string | null;
  registeredAt: Date;
  lastUpdated: Date;
  poolState?: {
    currentBalanceWei: bigint;
    totalDepositsWei: bigint;
    totalPremiumsWei: bigint;
    totalFeesPaidWei: bigint;
    totalRefundsWei: bigint;
    lastUpdated: Date;
  } | null;
};

function serializeEndpoint(
  row: EndpointRow,
  feeRecipients: { recipientAddress: string; kind: number; bps: number }[],
) {
  return {
    slug: row.slug,
    agentTokenId: row.agentTokenId,
    flatPremiumWei: row.flatPremiumWei.toString(),
    percentBps: row.percentBps,
    imputedCostWei: row.imputedCostWei.toString(),
    latencySloMs: row.latencySloMs,
    exposureCapPerHourWei: row.exposureCapPerHourWei.toString(),
    paused: row.paused,
    upstreamModel: row.upstreamModel,
    upstreamProvider: row.upstreamProvider,
    upstreamEndpoint: row.upstreamEndpoint,
    displayName: row.displayName,
    registeredAt: row.registeredAt,
    lastUpdated: row.lastUpdated,
    pool: row.poolState
      ? {
          currentBalanceWei: row.poolState.currentBalanceWei.toString(),
          totalDepositsWei: row.poolState.totalDepositsWei.toString(),
          totalPremiumsWei: row.poolState.totalPremiumsWei.toString(),
          totalFeesPaidWei: row.poolState.totalFeesPaidWei.toString(),
          totalRefundsWei: row.poolState.totalRefundsWei.toString(),
          lastUpdated: row.poolState.lastUpdated,
        }
      : null,
    feeRecipients: feeRecipients.map((f) => ({
      address: f.recipientAddress,
      kind: f.kind,
      bps: f.bps,
    })),
  };
}

@Controller('api/endpoints')
export class EndpointsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listEndpoints() {
    const rows = await this.prisma.endpoint.findMany({
      orderBy: { registeredAt: 'asc' },
      include: { poolState: true },
    });
    const fr = await this.prisma.feeRecipient.findMany();
    const bySlug = new Map<string, typeof fr>();
    for (const f of fr) {
      const l = bySlug.get(f.endpointSlug) ?? [];
      l.push(f);
      bySlug.set(f.endpointSlug, l);
    }
    return rows.map((r) => serializeEndpoint(r, bySlug.get(r.slug) ?? []));
  }

  @Get(':slug')
  async getEndpoint(@Param('slug') slug: string) {
    const endpoint = await this.prisma.endpoint.findUnique({
      where: { slug },
      include: { poolState: true },
    });
    if (!endpoint) throw new NotFoundException(`Endpoint not found: ${slug}`);
    const fr = await this.prisma.feeRecipient.findMany({
      where: { endpointSlug: slug },
    });
    return serializeEndpoint(endpoint, fr);
  }
}
