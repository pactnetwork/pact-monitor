import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generatePrivateKey } from 'viem/accounts';
import {
  decodePactCoreEvent,
  pactCoreAbi,
  RecipientKind,
  type PactCoreEvent,
} from '@pact-network/protocol-zerog-client';
import { ZerogStorageClient } from '@pact-network/zerog-storage-client';
import { PrismaService } from '../db/prisma.service';
import { ProjectionService, type ProjectionCtx } from '../projection/projection.service';
import { READ_CLIENTS } from '../chain/chain.module';
import type { ReadClients } from '../chain/chain';

const CURSOR_ID = 'pactcore';
const EVENT_ABIS = pactCoreAbi.filter((i) => i.type === 'event');
const RANGE_ERR = /range|too large|more than|limit|exceed|too many/i;

@Injectable()
export class LogReaderService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(LogReaderService.name);
  private storage!: ZerogStorageClient;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private readonly startBlock: bigint;
  private readonly pollMs: number;
  private readonly logRange: bigint;
  private _lastProcessed = 0n;

  constructor(
    @Inject(READ_CLIENTS) private readonly clients: ReadClients,
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly config: ConfigService,
  ) {
    this.startBlock = BigInt(this.config.getOrThrow<number>('INDEXER_START_BLOCK'));
    this.pollMs = this.config.getOrThrow<number>('POLL_INTERVAL_MS');
    this.logRange = BigInt(this.config.getOrThrow<number>('LOG_RANGE'));
  }

  get lastProcessed(): bigint {
    return this._lastProcessed;
  }

  async onApplicationBootstrap(): Promise<void> {
    // Evidence downloads don't sign — an ephemeral key is fine (read-only).
    this.storage = new ZerogStorageClient(
      {
        chainId: this.config.getOrThrow<number>('ZEROG_CHAIN_ID'),
        rpcUrl: this.config.getOrThrow<string>('ZEROG_RPC_URL'),
        indexerUrl: this.config.getOrThrow<string>('ZEROG_STORAGE_INDEXER_URL'),
      },
      generatePrivateKey(),
    );

    await this.prisma.indexerCursor.upsert({
      where: { id: CURSOR_ID },
      create: { id: CURSOR_ID, lastBlock: this.startBlock - 1n, updatedAt: new Date() },
      update: {},
    });
    try {
      this.projection.setProtocolPaused(await this.clients.pactCore.protocolPaused());
    } catch (e) {
      this.logger.warn(`protocolPaused() boot read failed: ${String(e)}`);
    }
    this.schedule(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight.catch(() => undefined);
    this.logger.log('Log reader drained.');
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inflight = this.tick();
      void this.inflight.finally(() => this.schedule(this.pollMs));
    }, ms);
  }

  /** One catch-up pass: drain from cursor to head, paginated. */
  async tick(): Promise<void> {
    try {
      const head = await this.clients.publicClient.getBlockNumber();
      let from = (await this.readCursor()) + 1n;
      while (from <= head && !this.stopped) {
        const to = from + this.logRange - 1n < head ? from + this.logRange - 1n : head;
        const logs = await this.getLogsAdaptive(from, to);
        await this.processPage(logs);
        await this.setCursor(to); // covers blocks with no PactCore logs
        this._lastProcessed = to;
        from = to + 1n;
      }
    } catch (e) {
      this.logger.error(`tick failed (will retry): ${String(e)}`);
    }
  }

  private async readCursor(): Promise<bigint> {
    const row = await this.prisma.indexerCursor.findUnique({
      where: { id: CURSOR_ID },
    });
    return row?.lastBlock ?? this.startBlock - 1n;
  }

  private async setCursor(block: bigint): Promise<void> {
    await this.prisma.indexerCursor.upsert({
      where: { id: CURSOR_ID },
      create: { id: CURSOR_ID, lastBlock: block, updatedAt: new Date() },
      update: { lastBlock: block, updatedAt: new Date() },
    });
  }

  /** getLogs with recursive bisection on RPC range/result-limit errors. */
  async getLogsAdaptive(from: bigint, to: bigint): Promise<unknown[]> {
    try {
      return (await this.clients.publicClient.getLogs({
        address: this.config.getOrThrow<string>('PACT_CORE_ADDRESS') as `0x${string}`,
        events: EVENT_ABIS as never,
        fromBlock: from,
        toBlock: to,
        strict: true,
      })) as unknown[];
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (from < to && RANGE_ERR.test(msg)) {
        const mid = from + (to - from) / 2n;
        const a = await this.getLogsAdaptive(from, mid);
        const b = await this.getLogsAdaptive(mid + 1n, to);
        return [...a, ...b];
      }
      throw e;
    }
  }

  private async processPage(rawLogs: unknown[]): Promise<void> {
    if (rawLogs.length === 0) return;
    const byBlock = new Map<bigint, PactCoreEvent[]>();
    for (const raw of rawLogs) {
      let ev: PactCoreEvent;
      try {
        ev = decodePactCoreEvent(raw as never);
      } catch {
        continue; // non-PactCore / unparseable — skip
      }
      const list = byBlock.get(ev.blockNumber) ?? [];
      list.push(ev);
      byBlock.set(ev.blockNumber, list);
    }

    for (const blockNum of [...byBlock.keys()].sort((a, b) => (a < b ? -1 : 1))) {
      if (this.stopped) return;
      const events = byBlock
        .get(blockNum)!
        .sort((a, b) => a.logIndex - b.logIndex);
      const block = await this.clients.publicClient.getBlock({
        blockNumber: blockNum,
      });
      const ts = new Date(Number(block.timestamp) * 1000);
      const ctx = await this.buildCtx(events);
      await this.prisma.$transaction((tx) =>
        this.projection.applyBlock(
          tx,
          { number: blockNum, timestamp: ts },
          events,
          ctx,
        ),
      );
    }
  }

  /** All reconciliation network I/O — done BEFORE the Prisma `$transaction`. */
  private async buildCtx(events: PactCoreEvent[]): Promise<ProjectionCtx> {
    const ctx: ProjectionCtx = {
      evidence: new Map(),
      feeRecipients: new Map(),
      endpointConfigs: new Map(),
    };
    const slugs = new Set<string>();
    const cfgSlugs = new Set<string>();
    for (const ev of events) {
      if ('slug' in ev) slugs.add(ev.slug);
      if (ev.eventName === 'EndpointConfigUpdated') cfgSlugs.add(ev.slug);
      if (ev.eventName === 'CallSettled') {
        try {
          const bytes = await this.storage.readEvidence(ev.rootHash);
          const j = JSON.parse(new TextDecoder().decode(bytes));
          ctx.evidence.set(ev.callId, {
            latencyMs: Number(j.latencyMs),
            outcome: String(j.outcome),
            breach: Boolean(j.breach),
            ts: String(j.ts),
          });
        } catch {
          ctx.evidence.set(ev.callId, null); // resilient: never block ingest
        }
      }
    }
    for (const slug of slugs) {
      try {
        const recips = await this.clients.pactCore.getFeeRecipients(
          slug as `0x${string}`,
        );
        ctx.feeRecipients.set(
          slug,
          recips.map((r) => ({
            address: r.destination,
            kind: r.kind === RecipientKind.Treasury ? 0 : 1,
            bps: r.bps,
          })),
        );
      } catch {
        ctx.feeRecipients.set(slug, []);
      }
    }
    for (const slug of cfgSlugs) {
      try {
        const c = await this.clients.pactCore.getEndpointConfig(
          slug as `0x${string}`,
        );
        ctx.endpointConfigs.set(slug, {
          agentTokenId: c.agentTokenId,
          flatPremium: c.flatPremium,
          percentBps: c.percentBps,
          imputedCost: c.imputedCost,
          latencySloMs: c.latencySloMs,
          exposureCapPerHour: c.exposureCapPerHour,
          paused: c.paused,
        });
      } catch {
        /* leave unset — handler no-ops without a config */
      }
    }
    return ctx;
  }
}
