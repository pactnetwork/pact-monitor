/**
 * Durable, append-only JSONL buffer of pending observations.
 *
 * Mirrors the durability PATTERN of `packages/monitor/src/storage.ts`
 * (synchronous append before any network, full-file rewrite to mark
 * progress, resume-on-startup) WITHOUT importing it — `@q3labs/pact-monitor`
 * is V2/backend-tied. Keyed by `callId` (not timestamp): one line per covered
 * call the SDK made, flipped to `reconciled` once the indexer confirms the
 * on-chain settlement.
 *
 * A hard kill never loses data — the next `createPact()` reloads the file and
 * the indexer poller resumes reconciling the unreconciled tail.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface PendingObservation {
  callId: string;
  agentPubkey: string;
  slug: string;
  host: string;
  /** ISO-8601 of the agent's outbound call. */
  ts: string;
  /** Provisional value from the X-Pact-Premium response header. */
  premiumLamports: string | null;
  refundLamports: string | null;
  outcome: string | null;
  breach: boolean | null;
  reconciled: boolean;
}

export class ObservationBuffer {
  private readonly path: string;

  constructor(storagePath: string) {
    this.path = storagePath;
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Durable synchronous append — call this BEFORE any reconciliation I/O. */
  append(obs: PendingObservation): void {
    appendFileSync(this.path, JSON.stringify(obs) + "\n", "utf8");
  }

  private readAll(): PendingObservation[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const out: PendingObservation[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as PendingObservation);
      } catch {
        // Skip a torn final line from a hard kill mid-write.
      }
    }
    return out;
  }

  /** All not-yet-settled observations (resume set on startup). */
  loadPending(): PendingObservation[] {
    return this.readAll().filter((o) => !o.reconciled);
  }

  /** Mark a call settled. Full-file rewrite, same as PactStorage.markSynced. */
  markReconciled(callId: string): void {
    const all = this.readAll();
    let changed = false;
    for (const o of all) {
      if (o.callId === callId && !o.reconciled) {
        o.reconciled = true;
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(
        this.path,
        all.map((o) => JSON.stringify(o)).join("\n") + "\n",
        "utf8",
      );
    }
  }

  stats(): {
    totalCalls: number;
    reconciledCalls: number;
    pendingCalls: number;
    totalPremiumLamportsObserved: bigint;
    totalRefundLamportsObserved: bigint;
    bySlug: Record<string, { calls: number; breaches: number }>;
  } {
    const all = this.readAll();
    let premium = 0n;
    let refund = 0n;
    let reconciled = 0;
    const bySlug: Record<string, { calls: number; breaches: number }> = {};
    for (const o of all) {
      if (o.reconciled) reconciled++;
      if (o.premiumLamports) premium += safeBig(o.premiumLamports);
      if (o.refundLamports) refund += safeBig(o.refundLamports);
      const s = (bySlug[o.slug] ??= { calls: 0, breaches: 0 });
      s.calls++;
      if (o.breach) s.breaches++;
    }
    return {
      totalCalls: all.length,
      reconciledCalls: reconciled,
      pendingCalls: all.length - reconciled,
      totalPremiumLamportsObserved: premium,
      totalRefundLamportsObserved: refund,
      bySlug,
    };
  }
}

function safeBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}
