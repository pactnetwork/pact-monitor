import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { MemoryStorage } from "../storage-memory.js";
import { selectStorage, isNodeFsAvailable } from "../storage-select.js";
import { aggregate, type PendingObservation } from "../storage.js";
import { randomBytes, sha256Hex } from "../crypto.js";

function obs(p: Partial<PendingObservation> & { callId: string }): PendingObservation {
  return {
    agentPubkey: "a",
    slug: "dummy",
    host: "h",
    ts: "t",
    premiumLamports: "100",
    refundLamports: "0",
    outcome: "ok",
    breach: false,
    reconciled: false,
    ...p,
  };
}

describe("MemoryStorage localStorage persistence", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists across instances via persistKey", () => {
    const a = new MemoryStorage({ persistKey: "K" });
    a.append(obs({ callId: "c1" }));
    a.append(obs({ callId: "c2", breach: true, refundLamports: "9" }));
    a.markReconciled("c1");
    // New instance hydrates from localStorage.
    const b = new MemoryStorage({ persistKey: "K" });
    expect(b.loadPending().map((o) => o.callId)).toEqual(["c2"]);
    expect(b.stats().totalCalls).toBe(2);
    expect(b.stats().reconciledCalls).toBe(1);
  });

  it("recovers from a corrupt persisted blob", () => {
    store["K"] = "{not json";
    const m = new MemoryStorage({ persistKey: "K" });
    expect(m.loadPending()).toEqual([]);
  });

  it("swallows a throwing setItem (quota/disabled)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    });
    const m = new MemoryStorage({ persistKey: "K" });
    expect(() => m.append(obs({ callId: "c1" }))).not.toThrow();
    expect(m.loadPending()).toHaveLength(1);
  });

  it("markReconciled on an unknown id is a no-op", () => {
    const m = new MemoryStorage({ persistKey: "K" });
    m.append(obs({ callId: "c1" }));
    m.markReconciled("nope");
    expect(m.loadPending()).toHaveLength(1);
  });
});

describe("selectStorage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-sel-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the explicit store untouched", async () => {
    const mem = new MemoryStorage();
    expect(await selectStorage({ storage: mem })).toBe(mem);
  });

  it("uses FsObservationBuffer on Node with a storagePath", async () => {
    expect(isNodeFsAvailable()).toBe(true);
    const s = await selectStorage({ storagePath: join(dir, "o.jsonl") });
    s.append(obs({ callId: "c1" }));
    expect(s.loadPending()).toHaveLength(1);
    // Round-trips through the file (a fresh instance reads it back).
    const s2 = await selectStorage({ storagePath: join(dir, "o.jsonl") });
    expect(s2.loadPending().map((o) => o.callId)).toEqual(["c1"]);
  });

  it("falls back to memory when no storagePath and no override", async () => {
    const s = await selectStorage({});
    s.append(obs({ callId: "c1" }));
    expect(s.loadPending()).toHaveLength(1);
  });
});

describe("aggregate", () => {
  it("tolerates non-numeric lamport strings", () => {
    const st = aggregate([
      obs({ callId: "c1", premiumLamports: "NaN", refundLamports: "x" }),
      obs({ callId: "c2", premiumLamports: "bad", breach: true, refundLamports: "5" }),
    ]);
    expect(st.totalPremiumLamportsObserved).toBe(0n);
    expect(st.totalRefundLamportsObserved).toBe(5n);
    expect(st.bySlug.dummy).toEqual({ calls: 2, breaches: 1 });
  });
});

describe("crypto guard", () => {
  it("randomBytes / sha256Hex throw a clear error without WebCrypto", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(() => randomBytes(8)).toThrow(/WebCrypto/);
      await expect(sha256Hex(new Uint8Array([1]))).rejects.toThrow(/WebCrypto/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
