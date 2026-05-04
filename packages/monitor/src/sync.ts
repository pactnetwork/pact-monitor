import type { EventEmitter } from "events";
import type { PactStorage } from "./storage.js";
import { serializeRecords, createSignature } from "./signing.js";
import bs58 from "bs58";

export interface SyncAuthError {
  status: number; // 401 or 403
  body: string;
}

export interface SyncTransientError {
  status: number; // 4xx (non-auth) or 5xx
  body: string;
}

export class PactSync {
  private storage: PactStorage;
  private backendUrl: string;
  private apiKey: string;
  private intervalMs: number;
  private batchSize: number;
  private readonly keypair: { publicKey: Uint8Array; secretKey: Uint8Array } | null;
  private events: EventEmitter | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight: Promise<void> | null = null;
  // Latch: once a 401/403 surfaces, the API key is rejected for this run. No
  // amount of retrying recovers without a new key. Stop spamming the backend
  // and stop swallowing the error — the consumer needs to know NOW.
  private authFailed = false;

  constructor(
    storage: PactStorage,
    backendUrl: string,
    apiKey: string,
    intervalMs: number,
    batchSize: number,
    keypair: { publicKey: Uint8Array; secretKey: Uint8Array } | null,
    events: EventEmitter | null = null,
  ) {
    this.storage = storage;
    this.backendUrl = backendUrl;
    this.apiKey = apiKey;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.keypair = keypair;
    this.events = events;
  }

  // Exposed so the wrapper can short-circuit "is sync still healthy?" checks
  // (and demos can fail loudly on shutdown if the auth latch fired). Read-only.
  isAuthFailed(): boolean {
    return this.authFailed;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch(() => { /* retry next interval */ });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(): Promise<void> {
    // Re-entrancy guard: if a previous flush is still in flight (e.g. the
    // interval timer fired again, or shutdown() races with the timer), join
    // the existing promise instead of reading storage a second time. Two
    // parallel flushes would both getUnsynced() the same records and POST
    // them twice, creating duplicate call_records rows on the backend —
    // each deriving a distinct claim PDA via sha256 and settling a fresh
    // on-chain refund. Sequencing the flushes eliminates the duplication.
    if (this.flushInFlight) {
      return this.flushInFlight;
    }
    this.flushInFlight = this.doFlush().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  private async doFlush(): Promise<void> {
    const unsynced = this.storage.getUnsynced();
    if (unsynced.length === 0) return;

    const batch = unsynced.slice(0, this.batchSize);
    const records = batch.map((r) => ({
      hostname: r.hostname,
      endpoint: r.endpoint,
      timestamp: r.timestamp,
      status_code: r.statusCode,
      latency_ms: r.latencyMs,
      classification: r.classification,
      payment_protocol: r.payment?.protocol ?? null,
      payment_amount: r.payment?.amount ?? null,
      payment_asset: r.payment?.asset ?? null,
      payment_network: r.payment?.network ?? null,
      payer_address: r.payment?.payerAddress ?? null,
      recipient_address: r.payment?.recipientAddress ?? null,
      tx_hash: r.payment?.txHash ?? null,
      settlement_success: r.payment?.settlementSuccess ?? null,
    }));

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "pact-monitor-sdk/0.1.0",
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.keypair) {
      try {
        const serialized = serializeRecords(records);
        headers["X-Pact-Signature"] = createSignature(serialized, this.keypair.secretKey);
        headers["X-Pact-Pubkey"] = bs58.encode(this.keypair.publicKey);
      } catch (err) {
        console.warn("[pact-monitor] record signing failed, sending unsigned:", (err as Error).message);
      }
    }

    const response = await globalThis.fetch(`${this.backendUrl}/api/v1/records`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records }),
    });

    if (response.ok) {
      this.storage.markSynced(batch.length);
      return;
    }

    // Read once for the diagnostic message — Response body is single-use
    // and useful errors (e.g. "Invalid API key") live here.
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore — body read failure is itself diagnostic noise; status is
      // enough to classify the error below.
    }

    if (response.status === 401 || response.status === 403) {
      // Permanent error. Stop the sync loop and surface loudly.
      // - Without this, the SDK retries every interval forever and the
      //   demo prints "billed 1.0000 USDC" while ZERO records reach the
      //   backend. The external-agent UX test caught this exact failure
      //   mode: the user thinks monitoring works.
      // - One log line + one event. Don't spam — an inert sync loop is
      //   better than a thousand identical logs.
      if (!this.authFailed) {
        this.authFailed = true;
        // eslint-disable-next-line no-console
        console.error(
          `[pact-monitor] sync rejected: ${response.status} ${body}. ` +
            "API key is invalid or revoked. The sync loop is now stopping; " +
            "no further records will be flushed for this PactMonitor instance. " +
            "Fix the apiKey config and create a new PactMonitor.",
        );
        if (this.events) {
          const evt: SyncAuthError = { status: response.status, body };
          this.events.emit("auth_error", evt);
        }
        // Stop the timer so the loop doesn't keep firing 401s every 30s.
        this.stop();
      }
      return;
    }

    // Other non-2xx: 400 (validation), 429 (rate limit), 5xx (server). All
    // retriable. Surface via event so demos can show a counter, but don't
    // spam stderr — the records stay queued for the next interval.
    if (this.events) {
      const evt: SyncTransientError = { status: response.status, body };
      this.events.emit("sync_error", evt);
    }
  }
}
