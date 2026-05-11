import {
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  decodeEndpointConfig,
  ENDPOINT_CONFIG_LEN,
  EndpointConfig,
  PROGRAM_ID,
} from "@pact-network/protocol-v1-client";
import {
  Connection,
  GetProgramAccountsResponse,
  PublicKey,
} from "@solana/web3.js";
import { PrismaService } from "../prisma/prisma.service";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_PROGRAM_ID = PROGRAM_ID.toBase58();

/**
 * Default `upstreamBase` URL per known endpoint slug — used on FIRST CREATE
 * only. The market-proxy's per-slug handler reads this column to resolve
 * upstream requests; an empty value crashes the proxy with `Invalid URL`
 * because `new URL("/path", "")` throws. API keys for upstreams that need
 * them (e.g. Helius) are injected by the proxy via env vars and are NOT
 * stored in the DB. Operators can override these defaults later via the
 * ops UI; the sync's update path does not clobber them.
 */
const DEFAULT_UPSTREAM_BASE: Record<string, string> = {
  helius: "https://mainnet.helius-rpc.com",
  birdeye: "https://public-api.birdeye.so",
  jupiter: "https://api.jup.ag",
  elfa: "https://api.elfa.ai",
  fal: "https://queue.fal.run",
  // Demo upstream — `pact-dummy-upstream` behind https://dummy.pactnetwork.io.
  // Used by the premium-coverage MVP; see docs/premium-coverage-mvp.md.
  dummy: "https://dummy.pactnetwork.io",
};

/**
 * Reads all `EndpointConfig` PDAs from the on-chain V1 program and upserts
 * them into the indexer's Postgres `Endpoint` table.
 *
 * Runs once on boot (async, non-blocking) and again every 5 minutes via
 * `@nestjs/schedule`. Replaces the FIX-4 lazy-create placeholder values
 * (paused: true + zeroed business fields) with real on-chain values for
 * endpoints registered via `register_endpoint`.
 *
 * Lazy-create remains as a safety net in `EventsService.ingest` for
 * unknown slugs that show up in settlement events before the next sync
 * tick — the next tick overwrites those rows with real values.
 */
@Injectable()
export class OnChainSyncService implements OnModuleInit {
  private readonly logger = new Logger(OnChainSyncService.name);
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private isRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const rpcUrl =
      this.config.get<string>("SOLANA_RPC_URL") ?? DEFAULT_RPC_URL;
    const programIdStr =
      this.config.get<string>("PROGRAM_ID") ?? DEFAULT_PROGRAM_ID;
    this.connection = new Connection(rpcUrl, "confirmed");
    this.programId = new PublicKey(programIdStr);
    this.logger.log(
      `OnChainSyncService configured rpc=${rpcUrl} program=${this.programId.toBase58()}`,
    );
  }

  /**
   * Kick off an initial sync at boot — fire-and-forget. We deliberately do
   * NOT `await` here so the indexer's HTTP server can start serving even if
   * the RPC is slow or unreachable. The Cron tick below covers retries.
   */
  onModuleInit(): void {
    void this.syncEndpointsFromChain().catch((err) => {
      this.logger.error(
        `boot sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Scheduled tick — every 5 minutes. The `isRunning` guard inside
   * `syncEndpointsFromChain` ensures two ticks never race even if a tick
   * runs longer than the interval.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledTick(): Promise<void> {
    await this.syncEndpointsFromChain();
  }

  /**
   * Fetch every EndpointConfig PDA via `getProgramAccounts` (server-side
   * filtered by exact account size), decode each, and upsert into the
   * `Endpoint` table by slug.
   *
   * Failures are logged but never thrown — the next tick retries. The
   * indexer process must NOT crash on a flaky RPC.
   */
  async syncEndpointsFromChain(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug("sync already in progress, skipping tick");
      return;
    }
    this.isRunning = true;
    const startedAt = Date.now();

    try {
      const accounts = await this.fetchEndpointConfigAccounts();
      let upserted = 0;
      for (const acct of accounts) {
        const slug = await this.upsertOne(acct);
        if (slug) upserted += 1;
      }
      const tookMs = Date.now() - startedAt;
      this.logger.log(
        `[chain-sync] upserted ${upserted} endpoints in ${tookMs}ms (fetched ${accounts.length})`,
      );
    } catch (err) {
      const tookMs = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[chain-sync] failed after ${tookMs}ms: ${msg}`,
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Server-side filter by `dataSize: 544` (= ENDPOINT_CONFIG_LEN). The
   * V1 program co-locates several account flavours under the same program
   * ID — ProtocolConfig (464), Treasury (80), SettlementAuthority (48),
   * CoveragePool (160), CallRecord (112). Filtering by exact size makes
   * the RPC return only EndpointConfigs without paying for full payloads
   * we'd then have to discard.
   *
   * Public mainnet RPC providers may strip the dataSize filter or rate-
   * limit unfiltered scans; we still rely on the Connection to honour
   * the filter when supported.
   */
  private async fetchEndpointConfigAccounts(): Promise<GetProgramAccountsResponse> {
    return this.connection.getProgramAccounts(this.programId, {
      filters: [{ dataSize: ENDPOINT_CONFIG_LEN }],
      commitment: "confirmed",
    });
  }

  /**
   * Decode a single account and upsert the corresponding Endpoint row.
   * Returns the decoded slug on success, or `null` if the decode failed
   * (we log + skip — one bad account doesn't block the rest of the batch).
   */
  private async upsertOne(
    acct: GetProgramAccountsResponse[number],
  ): Promise<string | null> {
    let decoded: EndpointConfig;
    try {
      decoded = decodeEndpointConfig(acct.account.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[chain-sync] decode failed for ${acct.pubkey.toBase58()}: ${msg}`,
      );
      return null;
    }

    const slug = slugBytesToString(decoded.slug);
    if (slug.length === 0) {
      this.logger.warn(
        `[chain-sync] empty slug for ${acct.pubkey.toBase58()}, skipping`,
      );
      return null;
    }

    const now = new Date();

    // Upsert by slug. On create we still set the off-chain-only metadata
    // fields (upstreamBase, displayName) to safe defaults — they aren't on
    // the EndpointConfig PDA and are managed via a separate ops UI; we DO
    // NOT clobber an existing row's upstreamBase/displayName/logoUrl on
    // update, only the on-chain-derived fields.
    //
    // Default upstreamBase per slug: chosen so the market-proxy's
    // per-slug handler (packages/market-proxy/src/endpoints/<slug>.ts)
    // can resolve a request URL without operator intervention. API keys
    // for upstreams that need them (e.g. Helius) are injected by the
    // proxy via env vars, NOT stored in the DB.
    const upstreamBase = DEFAULT_UPSTREAM_BASE[slug] ?? "";
    await this.prisma.endpoint.upsert({
      where: { slug },
      create: {
        slug,
        flatPremiumLamports: BigInt(decoded.flatPremiumLamports),
        percentBps: decoded.percentBps,
        slaLatencyMs: decoded.slaLatencyMs,
        imputedCostLamports: BigInt(decoded.imputedCostLamports),
        exposureCapPerHourLamports: BigInt(decoded.exposureCapPerHourLamports),
        paused: decoded.paused,
        upstreamBase,
        displayName: slug,
        registeredAt: now,
        lastUpdated: now,
      },
      update: {
        flatPremiumLamports: BigInt(decoded.flatPremiumLamports),
        percentBps: decoded.percentBps,
        slaLatencyMs: decoded.slaLatencyMs,
        imputedCostLamports: BigInt(decoded.imputedCostLamports),
        exposureCapPerHourLamports: BigInt(decoded.exposureCapPerHourLamports),
        paused: decoded.paused,
        lastUpdated: now,
      },
    });

    return slug;
  }
}

/**
 * Convert the on-chain 16-byte NUL-padded slug array to a JS string.
 * Mirrors `slugBytes()` in `@pact-network/protocol-v1-client/pda` in reverse:
 * strip every byte from the first NUL onward (bytes after the slug are
 * deterministically zero-filled).
 */
export function slugBytesToString(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, end),
  );
}
