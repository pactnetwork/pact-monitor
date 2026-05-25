import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, appendFileSync } from "node:fs";
import {
  ObservationBuffer,
  type PendingObservation,
} from "../observation-buffer.js";

function obs(callId: string, over: Partial<PendingObservation> = {}): PendingObservation {
  return {
    callId,
    agentPubkey: "AGENT",
    slug: "helius",
    host: "api.helius.xyz",
    ts: new Date().toISOString(),
    premiumLamports: "1000",
    refundLamports: "0",
    outcome: "ok",
    breach: false,
    reconciled: false,
    ...over,
  };
}

describe("ObservationBuffer", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-buf-"));
    path = join(dir, "nested", "obs.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the parent directory and appends durably", () => {
    const b = new ObservationBuffer(path);
    b.append(obs("c1"));
    b.append(obs("c2", { breach: true, refundLamports: "500" }));
    expect(b.loadPending().map((o) => o.callId)).toEqual(["c1", "c2"]);
  });

  it("markReconciled flips an entry and survives reload (resume)", () => {
    const b = new ObservationBuffer(path);
    b.append(obs("c1"));
    b.append(obs("c2"));
    b.markReconciled("c1");

    const reloaded = new ObservationBuffer(path);
    expect(reloaded.loadPending().map((o) => o.callId)).toEqual(["c2"]);
  });

  it("stats aggregates premium/refund and per-slug breaches", () => {
    const b = new ObservationBuffer(path);
    b.append(obs("c1", { premiumLamports: "1000", refundLamports: "0" }));
    b.append(
      obs("c2", {
        premiumLamports: "1000",
        refundLamports: "9000",
        breach: true,
        slug: "dummy",
      }),
    );
    b.markReconciled("c1");
    const s = b.stats();
    expect(s.totalCalls).toBe(2);
    expect(s.reconciledCalls).toBe(1);
    expect(s.pendingCalls).toBe(1);
    expect(s.totalPremiumLamportsObserved).toBe(2000n);
    expect(s.totalRefundLamportsObserved).toBe(9000n);
    expect(s.bySlug.dummy).toEqual({ calls: 1, breaches: 1 });
    expect(s.bySlug.helius).toEqual({ calls: 1, breaches: 0 });
  });

  it("tolerates a torn final line from a hard kill", () => {
    const b = new ObservationBuffer(path);
    b.append(obs("c1"));
    appendFileSync(path, '{"callId":"c2","brok');
    expect(b.loadPending().map((o) => o.callId)).toEqual(["c1"]);
  });

  it("returns empty when the file does not exist yet", () => {
    expect(new ObservationBuffer(path).loadPending()).toEqual([]);
  });
});
