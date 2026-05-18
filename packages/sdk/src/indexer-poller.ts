/**
 * Best-effort reconciliation poller.
 *
 * V1 refunds are automatic and settler-driven; the agent never submits a
 * claim. The settled truth (premium charged, refund paid, on-chain tx) lands
 * in the indexer. This poller reads the agent's settled calls from
 * `GET {indexerBaseUrl}/api/agents/:pubkey/calls?limit=N` (no auth — see
 * `packages/indexer/src/api/agents.controller.ts`), correlates them by
 * `callId` against the local observation buffer, and fires `refund`/`billed`.
 *
 * "Best-effort" is load-bearing (plan blocker B2): the indexer's public host
 * is unverified, and the refund happens on-chain regardless of whether the
 * SDK ever observes it. If the indexer is unreachable the poller stays
 * silent, surfaces an optional `onError`, and retries next tick. It NEVER
 * throws and NEVER affects the golden rule.
 */
import type { ObservationBuffer } from "./observation-buffer.js";

/** Wire shape from indexer agents.controller.ts `serializeCall`. */
interface AgentCallWire {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  latencyMs: number;
  breach: boolean;
  breachReason: string | null;
  source: string | null;
  ts: string;
  settledAt: string;
  signature: string;
}

export interface RefundEventData {
  callId: string;
  slug: string;
  refundLamports: bigint;
  settledAt: Date;
  txSignature: string;
}

export interface BilledEventData {
  callId: string;
  slug: string;
  premiumLamports: bigint;
  settledAt: Date;
  txSignature: string;
}

export interface IndexerPollerOptions {
  indexerBaseUrl: string;
  agentPubkey: string;
  buffer: ObservationBuffer;
  intervalMs: number;
  limit?: number;
  fetchImpl?: typeof fetch;
  onRefund?: (e: RefundEventData) => void;
  onBilled?: (e: BilledEventData) => void;
  onError?: (err: Error) => void;
}

function toBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

export class IndexerPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly fetchImpl: typeof fetch;
  private readonly limit: number;

  constructor(private readonly opts: IndexerPollerOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.limit = opts.limit ?? 50;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One reconciliation pass. Never throws. */
  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = this.opts.buffer.loadPending();
      if (pending.length === 0) return;
      const pendingIds = new Set(pending.map((p) => p.callId));

      const url =
        `${this.opts.indexerBaseUrl}/api/agents/` +
        `${encodeURIComponent(this.opts.agentPubkey)}/calls?limit=${this.limit}`;

      let rows: AgentCallWire[];
      try {
        const resp = await this.fetchImpl(url);
        if (!resp.ok) return; // best-effort: retry next tick
        rows = (await resp.json()) as AgentCallWire[];
      } catch (err) {
        this.opts.onError?.(err as Error);
        return;
      }
      if (!Array.isArray(rows)) return;

      for (const row of rows) {
        if (!pendingIds.has(row.callId)) continue;
        const settledAt = new Date(row.settledAt);
        const premium = toBig(row.premiumLamports);
        const refund = toBig(row.refundLamports);

        if (premium > 0n) {
          this.opts.onBilled?.({
            callId: row.callId,
            slug: row.endpointSlug,
            premiumLamports: premium,
            settledAt,
            txSignature: row.signature,
          });
        }
        if (row.breach && refund > 0n) {
          this.opts.onRefund?.({
            callId: row.callId,
            slug: row.endpointSlug,
            refundLamports: refund,
            settledAt,
            txSignature: row.signature,
          });
        }
        this.opts.buffer.markReconciled(row.callId);
      }
    } catch (err) {
      // Defensive: reconciliation must never escape.
      this.opts.onError?.(err as Error);
    } finally {
      this.running = false;
    }
  }
}
