// AttributionWatchdog (E4) — exists-true drops, exists-false appends,
// shutdown cancels pending timers.

import { describe, it, expect } from "vitest";
import { AttributionWatchdog } from "../attribution-watchdog.js";
import type { PendingObservation } from "../storage.js";

function fixedFallback(callId: string): PendingObservation {
  return {
    callId,
    agentPubkey: "PK_A",
    slug: "test-slug",
    host: "api.test.local",
    ts: new Date().toISOString(),
    premiumLamports: null,
    refundLamports: null,
    outcome: "ok",
    breach: false,
    reconciled: false,
  };
}

// Synchronous setTimeout shim so tests don't actually wait. The watchdog
// calls `setTimeoutImpl` with a callback + delay; our shim immediately
// queues the callback as a microtask via Promise.resolve so `await` after
// schedule() fires the check synchronously.
function syncTimer() {
  let pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  const impl = ((fn: () => void) => {
    const entry = { fn, cancelled: false };
    pending.push(entry);
    return {
      unref() {},
      ref() {},
      hasRef() { return true; },
      refresh() { return this; },
      _onTimeout() { fn(); },
      _idleTimeout: 0,
      _idleNext: null,
      _idlePrev: null,
      _idleStart: 0,
      _repeat: null,
      _destroyed: false,
      [Symbol.toPrimitive]() { return pending.length; },
      [Symbol.dispose]() {},
    } as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  // Mark the impl so clearTimeout knows what to do.
  const clearImpl = ((t: NodeJS.Timeout) => {
    // For test simplicity: mark all pending as cancelled. The watchdog
    // calls cancelAll() which iterates clearTimeout per timer.
    for (const p of pending) p.cancelled = true;
  });
  function fireAll() {
    const toFire = pending.filter((p) => !p.cancelled);
    pending = [];
    for (const p of toFire) p.fn();
  }
  return { impl, fireAll, clear: clearImpl };
}

describe("AttributionWatchdog", () => {
  it("appends fallback observation when /records/peek returns exists:false", async () => {
    const { impl, fireAll } = syncTimer();
    const appended: PendingObservation[] = [];
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ exists: false }), { status: 200 })) as unknown as typeof fetch;
    const w = new AttributionWatchdog({
      backendBaseUrl: "http://test",
      agentPubkey: "PK_A",
      fetchImpl: fakeFetch,
      setTimeoutImpl: impl,
      onFallback: (entry) => appended.push(entry),
    });
    w.schedule({
      callId: "c1",
      startedAt: 1_717_000_000_000,
      endpoint: "slug-x",
      fallback: fixedFallback("c1"),
    });
    fireAll();
    // The check is async; flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    expect(appended.length).toBe(1);
    expect(appended[0].callId).toBe("c1");
  });

  it("does NOT append when /records/peek returns exists:true", async () => {
    const { impl, fireAll } = syncTimer();
    const appended: PendingObservation[] = [];
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ exists: true }), { status: 200 })) as unknown as typeof fetch;
    const w = new AttributionWatchdog({
      backendBaseUrl: "http://test",
      agentPubkey: "PK_A",
      fetchImpl: fakeFetch,
      setTimeoutImpl: impl,
      onFallback: (entry) => appended.push(entry),
    });
    w.schedule({
      callId: "c2",
      startedAt: 1_717_000_000_000,
      endpoint: "slug-x",
      fallback: fixedFallback("c2"),
    });
    fireAll();
    await new Promise((r) => setImmediate(r));
    expect(appended.length).toBe(0);
  });

  it("does NOT append when /records/peek itself errors (conservative)", async () => {
    const { impl, fireAll } = syncTimer();
    const appended: PendingObservation[] = [];
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const w = new AttributionWatchdog({
      backendBaseUrl: "http://test",
      agentPubkey: "PK_A",
      fetchImpl: fakeFetch,
      setTimeoutImpl: impl,
      onFallback: (entry) => appended.push(entry),
    });
    w.schedule({
      callId: "c3",
      startedAt: 1_717_000_000_000,
      endpoint: "slug-x",
      fallback: fixedFallback("c3"),
    });
    fireAll();
    await new Promise((r) => setImmediate(r));
    expect(appended.length).toBe(0);
  });

  it("cancelAll() clears pending timers (real setTimeout)", async () => {
    // Use real setTimeout — schedule, immediately cancelAll, assert nothing
    // fires after the original 5s delay (we wait a tiny bit, not 5s).
    const appended: PendingObservation[] = [];
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ exists: false }), { status: 200 })) as unknown as typeof fetch;
    const w = new AttributionWatchdog({
      backendBaseUrl: "http://test",
      agentPubkey: "PK_A",
      fetchImpl: fakeFetch,
      onFallback: (entry) => appended.push(entry),
      delayMs: 30,
    });
    w.schedule({
      callId: "c4",
      startedAt: 1_717_000_000_000,
      endpoint: "slug-x",
      fallback: fixedFallback("c4"),
    });
    expect(w.pendingCount()).toBe(1);
    w.cancelAll();
    expect(w.pendingCount()).toBe(0);
    // Wait longer than the would-have-been delay; nothing should fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(appended.length).toBe(0);
  });
});
