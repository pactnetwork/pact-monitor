/**
 * Runtime selection of the `PactStorage` impl.
 *
 * - explicit `config.storage`            -> use it (full override)
 * - Node + a resolvable `storagePath`    -> FsObservationBuffer (JSONL)
 * - browser/serverless (no node:fs)      -> MemoryStorage
 *
 * `observation-buffer.ts` (which statically imports `node:fs`) is loaded via
 * DYNAMIC import inside the Node branch only, so a browser bundler never
 * resolves `node:*`. Hence this function is async; `createPact()` awaits it.
 */
import type { PactStorage } from "./storage.js";
import { MemoryStorage } from "./storage-memory.js";

export function isNodeFsAvailable(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } })
    .process;
  return !!p?.versions?.node;
}

export async function selectStorage(cfg: {
  storage?: PactStorage;
  storagePath?: string;
  /** localStorage key for the browser impl when no explicit storage given. */
  memoryPersistKey?: string;
}): Promise<PactStorage> {
  if (cfg.storage) return cfg.storage;
  if (isNodeFsAvailable() && cfg.storagePath) {
    const { FsObservationBuffer } = await import("./observation-buffer.js");
    return new FsObservationBuffer(cfg.storagePath);
  }
  return new MemoryStorage({ persistKey: cfg.memoryPersistKey });
}
