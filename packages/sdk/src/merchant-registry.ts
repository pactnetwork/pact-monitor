/**
 * Merchant pubkey -> hostnames cache (E5).
 *
 * Backs the agent SDK's X-Pact-Proxied-By verification in golden-fetch.ts.
 * The registry is fetched from `GET <backendBaseUrl>/api/v1/merchants` at
 * boot and refreshed periodically (default 5 minutes) using ETag/If-None-Match
 * so the agent never re-downloads an unchanged registry. Pattern mirrors
 * slug-resolver.ts.
 *
 * `hasMerchant()` is the hot-path check used per response. Unknown pubkeys
 * are treated as "no attestation present" — the SDK records normally,
 * matching the spec's fail-safe-to-record semantics so a malicious upstream
 * can't suppress an agent's coverage by spoofing an unregistered pubkey.
 */
export interface MerchantRegistryEntry {
  pubkey: string;
  label: string;
  hostnames: string[];
}

export interface MerchantsResponse {
  merchants: MerchantRegistryEntry[];
  generatedAt: string;
}

export interface MerchantRegistryOptions {
  backendBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Background refresh cadence in ms. Default 5 minutes. */
  refreshIntervalMs?: number;
  /** Test hook. */
  now?: () => number;
}

const DEFAULT_REFRESH_MS = 5 * 60_000;

export class MerchantRegistry {
  private readonly backendBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshIntervalMs: number;

  private pubkeys = new Set<string>();
  private hostnames = new Map<string, string[]>();
  private etag: string | null = null;
  private inflight: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: MerchantRegistryOptions) {
    this.backendBaseUrl = opts.backendBaseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  }

  /**
   * Kick off the boot fetch + schedule background refresh. Resolves after
   * the boot fetch settles (or fails — never throws). The returned promise
   * is `void` so a missed boot fetch never blocks `createPact()`.
   */
  async start(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /** Stop the refresh timer. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** True if `pubkey` is a known active merchant. */
  hasMerchant(pubkey: string): boolean {
    return this.pubkeys.has(pubkey);
  }

  /** Active hostnames registered to `pubkey`, or undefined when unknown. */
  getMerchantHostnames(pubkey: string): string[] | undefined {
    return this.hostnames.get(pubkey);
  }

  /** Force a refresh now (skip the interval). */
  async refresh(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<boolean> {
    const url = `${this.backendBaseUrl}/api/v1/merchants`;
    let resp: Response;
    try {
      const headers: Record<string, string> = {};
      if (this.etag) headers["If-None-Match"] = this.etag;
      resp = await this.fetchImpl(url, { headers });
    } catch {
      return false;
    }
    if (resp.status === 304) {
      // Unchanged — cache stays intact.
      return true;
    }
    if (!resp.ok) {
      return false;
    }
    let body: MerchantsResponse;
    try {
      body = (await resp.json()) as MerchantsResponse;
    } catch {
      return false;
    }
    if (!body || !Array.isArray(body.merchants)) return false;

    const nextPubkeys = new Set<string>();
    const nextHostnames = new Map<string, string[]>();
    for (const m of body.merchants) {
      if (!m || typeof m.pubkey !== "string") continue;
      nextPubkeys.add(m.pubkey);
      nextHostnames.set(m.pubkey, Array.isArray(m.hostnames) ? m.hostnames : []);
    }
    this.pubkeys = nextPubkeys;
    this.hostnames = nextHostnames;
    const newEtag = resp.headers.get("etag");
    if (newEtag) this.etag = newEtag;
    return true;
  }
}
