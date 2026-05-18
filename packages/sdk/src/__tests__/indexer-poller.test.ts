import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { ObservationBuffer } from "../observation-buffer.js";
import { IndexerPoller } from "../indexer-poller.js";

function call(over: Record<string, unknown> = {}) {
  return {
    callId: "c1",
    agentPubkey: "AGENT",
    endpointSlug: "helius",
    premiumLamports: "1000",
    refundLamports: "0",
    latencyMs: 120,
    breach: false,
    breachReason: null,
    source: "proxy",
    ts: "2026-05-18T00:00:00.000Z",
    settledAt: "2026-05-18T00:00:05.000Z",
    signature: "SIG",
    ...over,
  };
}

describe("IndexerPoller", () => {
  let dir: string;
  let buffer: ObservationBuffer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-poll-"));
    buffer = new ObservationBuffer(join(dir, "obs.jsonl"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seed(callId: string) {
    buffer.append({
      callId,
      agentPubkey: "AGENT",
      slug: "helius",
      host: "api.helius.xyz",
      ts: "2026-05-18T00:00:00.000Z",
      premiumLamports: null,
      refundLamports: null,
      outcome: null,
      breach: null,
      reconciled: false,
    });
  }

  it("fires billed + refund for a settled breached call and reconciles it", async () => {
    seed("c1");
    const refunds: unknown[] = [];
    const billed: unknown[] = [];
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          call({ breach: true, refundLamports: "9000", premiumLamports: "1000" }),
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const p = new IndexerPoller({
      indexerBaseUrl: "https://indexer",
      agentPubkey: "AGENT",
      buffer,
      intervalMs: 10_000,
      fetchImpl,
      onRefund: (e) => refunds.push(e),
      onBilled: (e) => billed.push(e),
    });
    await p.flush();

    expect(billed).toHaveLength(1);
    expect(refunds).toHaveLength(1);
    expect((refunds[0] as { refundLamports: bigint }).refundLamports).toBe(9000n);
    expect(buffer.loadPending()).toHaveLength(0); // reconciled
  });

  it("ignores indexer rows the SDK did not record", async () => {
    seed("mine");
    const billed: unknown[] = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify([call({ callId: "someone-else" })]), {
        status: 200,
      })) as unknown as typeof fetch;
    const p = new IndexerPoller({
      indexerBaseUrl: "https://indexer",
      agentPubkey: "AGENT",
      buffer,
      intervalMs: 10_000,
      fetchImpl,
      onBilled: (e) => billed.push(e),
    });
    await p.flush();
    expect(billed).toHaveLength(0);
    expect(buffer.loadPending()).toHaveLength(1);
  });

  it("stays silent and keeps pending when the indexer is unreachable (B2)", async () => {
    seed("c1");
    let errored: Error | null = null;
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND indexer");
    }) as unknown as typeof fetch;
    const p = new IndexerPoller({
      indexerBaseUrl: "https://indexer",
      agentPubkey: "AGENT",
      buffer,
      intervalMs: 10_000,
      fetchImpl,
      onError: (e) => (errored = e),
    });
    await expect(p.flush()).resolves.toBeUndefined();
    expect(errored).toBeInstanceOf(Error);
    expect(buffer.loadPending()).toHaveLength(1); // retried next tick
  });

  it("treats a non-200 indexer response as a soft miss", async () => {
    seed("c1");
    const billed: unknown[] = [];
    const fetchImpl = (async () =>
      new Response("err", { status: 503 })) as unknown as typeof fetch;
    const p = new IndexerPoller({
      indexerBaseUrl: "https://indexer",
      agentPubkey: "AGENT",
      buffer,
      intervalMs: 10_000,
      fetchImpl,
      onBilled: (e) => billed.push(e),
    });
    await p.flush();
    expect(billed).toHaveLength(0);
    expect(buffer.loadPending()).toHaveLength(1);
  });

  it("no-ops when there is nothing pending (no indexer call)", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const p = new IndexerPoller({
      indexerBaseUrl: "https://indexer",
      agentPubkey: "AGENT",
      buffer,
      intervalMs: 10_000,
      fetchImpl,
    });
    await p.flush();
    expect(called).toBe(0);
  });
});
