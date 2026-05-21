/**
 * Attribution watchdog (E4).
 *
 * When a covered call's response carries a verified X-Pact-Proxied-By
 * attestation, the agent SDK skips its own record write — the merchant is
 * the server-of-record. But if the merchant signed but never actually POSTs
 * /api/v1/observations (their backend crashed, their middleware lost the
 * fire-and-forget, network blip), the agent would silently have no record
 * for the call and no claim could ever settle.
 *
 * The watchdog covers that gap: per attributed call, schedule a short
 * timeout, then poll /api/v1/records/peek. If the record doesn't exist,
 * append the buffered fallback observation locally and let the next sync
 * batch land it in /records the normal way.
 *
 * All timers `.unref()` so an agent that exits without `shutdown()` doesn't
 * hang the Node event loop. `cancelAll()` is wired into `LifecycleManager`'s
 * shutdown hook so tests + serverless return paths flush cleanly.
 */
import type { PendingObservation } from "./storage.js";

export interface AttributionWatchdogOptions {
  backendBaseUrl: string;
  agentPubkey: string;
  fetchImpl?: typeof fetch;
  /** Poll delay after attestation. Default 5 seconds. */
  delayMs?: number;
  /** Test hook. */
  setTimeoutImpl?: typeof setTimeout;
  /** Callback invoked when fallback is needed. */
  onFallback: (entry: PendingObservation) => void;
  /** Optional error sink for the peek request (best-effort; logs only). */
  onError?: (err: unknown) => void;
}

export interface ScheduleInput {
  callId: string | null;
  startedAt: number;
  endpoint: string;
  fallback: PendingObservation;
}

const DEFAULT_DELAY_MS = 5_000;

export class AttributionWatchdog {
  private readonly backendBaseUrl: string;
  private readonly agentPubkey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly delayMs: number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly onFallback: (entry: PendingObservation) => void;
  private readonly onError?: (err: unknown) => void;
  private readonly pending = new Set<NodeJS.Timeout>();

  constructor(opts: AttributionWatchdogOptions) {
    this.backendBaseUrl = opts.backendBaseUrl.replace(/\/+$/, "");
    this.agentPubkey = opts.agentPubkey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.onFallback = opts.onFallback;
    this.onError = opts.onError;
  }

  schedule(input: ScheduleInput): void {
    const timer = this.setTimeoutImpl(() => {
      this.pending.delete(timer);
      void this.check(input);
    }, this.delayMs);
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
    this.pending.add(timer);
  }

  /** Number of in-flight watchdog timers — exposed for tests. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Cancel all in-flight watchdog timers. Used by LifecycleManager.shutdown. */
  cancelAll(): void {
    for (const t of [...this.pending]) {
      clearTimeout(t);
    }
    this.pending.clear();
  }

  private async check(input: ScheduleInput): Promise<void> {
    const params = new URLSearchParams({
      agent_pubkey: this.agentPubkey,
      started_at: String(input.startedAt),
      endpoint: input.endpoint,
    });
    const url = `${this.backendBaseUrl}/api/v1/records/peek?${params.toString()}`;
    let exists = false;
    try {
      const resp = await this.fetchImpl(url);
      if (!resp.ok) {
        // Peek itself failing is non-fatal — we can't prove the merchant
        // didn't record, so the conservative choice is to NOT append
        // (avoid double-write). The next reconciliation cycle still works.
        return;
      }
      const body = (await resp.json()) as { exists?: boolean };
      exists = body?.exists === true;
    } catch (err) {
      this.onError?.(err);
      return;
    }
    if (!exists) {
      this.onFallback(input.fallback);
    }
  }
}
