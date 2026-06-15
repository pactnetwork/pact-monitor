/**
 * In-memory `PactStorage` for browsers / serverless (no `node:fs`).
 *
 * Optionally mirrors to `localStorage` (when present and a `persistKey` is
 * given) so a page reload can resume reconciliation — the same durability
 * intent as the JSONL file, best-effort. Without persistence it is a pure
 * process-lifetime buffer (acceptable: the on-chain refund settles regardless;
 * the buffer only drives local `refund`/`billed` event observation).
 */
import {
  aggregate,
  type ObservationStats,
  type PactStorage,
  type PendingObservation,
} from "./storage.js";

interface LocalStorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function localStore(): LocalStorageLike | null {
  const ls = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  return ls && typeof ls.getItem === "function" ? ls : null;
}

export class MemoryStorage implements PactStorage {
  private rows: PendingObservation[] = [];
  private readonly persistKey: string | null;

  constructor(opts?: { persistKey?: string }) {
    this.persistKey = opts?.persistKey ?? null;
    if (this.persistKey) {
      const ls = localStore();
      const raw = ls?.getItem(this.persistKey);
      if (raw) {
        try {
          this.rows = JSON.parse(raw) as PendingObservation[];
        } catch {
          this.rows = [];
        }
      }
    }
  }

  private persist(): void {
    if (!this.persistKey) return;
    const ls = localStore();
    try {
      ls?.setItem(this.persistKey, JSON.stringify(this.rows));
    } catch {
      // Quota / disabled storage — best-effort, never throw.
    }
  }

  append(obs: PendingObservation): void {
    this.rows.push(obs);
    this.persist();
  }

  loadPending(): PendingObservation[] {
    return this.rows.filter((o) => !o.reconciled);
  }

  markReconciled(callId: string): void {
    let changed = false;
    for (const o of this.rows) {
      if (o.callId === callId && !o.reconciled) {
        o.reconciled = true;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  stats(): ObservationStats {
    return aggregate(this.rows);
  }
}
