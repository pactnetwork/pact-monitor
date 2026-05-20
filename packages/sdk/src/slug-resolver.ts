/**
 * hostname -> endpoint-slug resolution via the Pact Market proxy discovery
 * document: `GET {proxyBaseUrl}/.well-known/endpoints` (no auth). Shape and
 * semantics mirror `packages/market-proxy/src/routes/well-known.ts` and the
 * CLI's `packages/cli/src/lib/discovery.ts`.
 *
 * V1 has no agent-side provisioning: an unregistered hostname is not an
 * error, it is a signal to degrade to a bare fetch (golden rule). The
 * resolver therefore never throws — it returns a discriminated result.
 *
 *  - server-driven TTL cache (the doc carries `cacheTtlSec`)
 *  - 5-minute negative cache so a flood of calls to an unknown host does not
 *    refetch discovery every time, while still letting the curated set grow
 *  - single in-flight refresh shared by concurrent callers (dedupe)
 *  - stale-cache fallback when discovery is unreachable (like the CLI)
 */
export interface DiscoveryEndpoint {
  slug: string;
  hostnames: string[];
  premiumBps: number;
  paused: boolean;
}

export interface DiscoveryResponse {
  cacheTtlSec: number;
  endpoints: DiscoveryEndpoint[];
}

export interface SlugEntry {
  slug: string;
  premiumBps: number;
  paused: boolean;
}

export type SlugResolution =
  | { ok: true; entry: SlugEntry }
  | {
      ok: false;
      reason: "unregistered" | "paused" | "discovery_failed";
      hostname: string;
    };

const NEGATIVE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_TTL_MS = 3_600_000;

export interface SlugResolverOptions {
  proxyBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class SlugResolver {
  private readonly proxyBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /** hostname (canonical) -> entry, from the last good discovery doc. */
  private hostToEntry = new Map<string, SlugEntry>();
  /** hostname -> epoch ms when it was confirmed unknown. */
  private negative = new Map<string, number>();
  private cacheExpiresAt = 0;
  private haveGoodCache = false;
  private inflight: Promise<boolean> | null = null;

  constructor(opts: SlugResolverOptions) {
    this.proxyBaseUrl = opts.proxyBaseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** `hostname` MUST already be canonicalized by the caller. */
  async resolve(hostname: string): Promise<SlugResolution> {
    const cached = this.hostToEntry.get(hostname);
    if (cached && this.now() < this.cacheExpiresAt) {
      return cached.paused
        ? { ok: false, reason: "paused", hostname }
        : { ok: true, entry: cached };
    }

    const negAt = this.negative.get(hostname);
    if (
      negAt !== undefined &&
      this.now() - negAt < NEGATIVE_TTL_MS &&
      this.now() < this.cacheExpiresAt
    ) {
      return { ok: false, reason: "unregistered", hostname };
    }

    const refreshed = await this.refresh();
    if (!refreshed && !this.haveGoodCache) {
      return { ok: false, reason: "discovery_failed", hostname };
    }

    const entry = this.hostToEntry.get(hostname);
    if (!entry) {
      this.negative.set(hostname, this.now());
      return { ok: false, reason: "unregistered", hostname };
    }
    return entry.paused
      ? { ok: false, reason: "paused", hostname }
      : { ok: true, entry };
  }

  /** Force the next resolve() to refetch discovery. */
  invalidate(): void {
    this.cacheExpiresAt = 0;
  }

  private refresh(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<boolean> {
    const url = `${this.proxyBaseUrl}/.well-known/endpoints`;
    let body: DiscoveryResponse;
    try {
      const resp = await this.fetchImpl(url);
      if (!resp.ok) return false;
      body = (await resp.json()) as DiscoveryResponse;
    } catch {
      return false;
    }
    if (!body || !Array.isArray(body.endpoints)) return false;

    const next = new Map<string, SlugEntry>();
    for (const ep of body.endpoints) {
      if (!ep || typeof ep.slug !== "string") continue;
      const entry: SlugEntry = {
        slug: ep.slug,
        premiumBps: Number(ep.premiumBps ?? 0),
        paused: Boolean(ep.paused),
      };
      for (const h of ep.hostnames ?? []) {
        next.set(h.toLowerCase().replace(/\.+$/, ""), entry);
      }
    }

    this.hostToEntry = next;
    this.negative.clear();
    const ttlMs =
      typeof body.cacheTtlSec === "number" && body.cacheTtlSec > 0
        ? body.cacheTtlSec * 1000
        : DEFAULT_CACHE_TTL_MS;
    this.cacheExpiresAt = this.now() + ttlMs;
    this.haveGoodCache = true;
    return true;
  }
}
