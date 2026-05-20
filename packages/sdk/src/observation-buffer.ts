/**
 * Node JSONL implementation of `PactStorage`.
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
 *
 * This module statically imports `node:fs`/`node:path`; it is loaded ONLY via
 * the dynamic import in `storage-select.ts` (Node branch) so a browser bundle
 * never resolves `node:*`. `MemoryStorage` is the browser impl.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  aggregate,
  type ObservationStats,
  type PactStorage,
  type PendingObservation,
} from "./storage.js";

export type { PendingObservation } from "./storage.js";

export class FsObservationBuffer implements PactStorage {
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

  /** Mark a call settled. Idempotent: only flips a pending row. */
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

  stats(): ObservationStats {
    return aggregate(this.readAll());
  }
}

/**
 * Back-compat alias. The class was renamed `FsObservationBuffer` when the
 * `PactStorage` abstraction was introduced; existing callers/tests construct
 * `new ObservationBuffer(path)` and must keep working.
 */
export { FsObservationBuffer as ObservationBuffer };
