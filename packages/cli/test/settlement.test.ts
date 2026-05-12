import { describe, expect, test } from "bun:test";
import { pollSettlement, solscanUrl } from "../src/lib/settlement.ts";

const VALID_CALL_ID = "11111111-2222-4333-8444-555555555555";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("lib/settlement: pollSettlement", () => {
  test("returns settled when the Call row has a signature on the first poll", async () => {
    let calls = 0;
    const r = await pollSettlement({
      gatewayUrl: "https://gw.example",
      callId: VALID_CALL_ID,
      windowMs: 30_000,
      intervalMs: 3_000,
      sleep: async () => {},
      now: () => 0,
      fetchImpl: (async (url: string) => {
        calls += 1;
        expect(url).toBe(`https://gw.example/v1/calls/${VALID_CALL_ID}`);
        return jsonResponse({
          callId: VALID_CALL_ID,
          signature: "SiGabc123",
          premiumLamports: "123",
          refundLamports: "0",
          breach: false,
          breachReason: null,
          settledAt: "2026-05-12T00:00:00.000Z",
          latencyMs: 42,
        });
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(1);
    expect(r.kind).toBe("settled");
    if (r.kind !== "settled") throw new Error("unreachable");
    expect(r.call.signature).toBe("SiGabc123");
    expect(r.call.premiumLamports).toBe(123);
    expect(r.call.premiumUsdc).toBeCloseTo(0.000123, 9);
    expect(r.call.refundLamports).toBe(0);
    expect(r.call.breach).toBe(false);
    expect(r.call.settledAt).toBe("2026-05-12T00:00:00.000Z");
    expect(r.call.latencyMs).toBe(42);
  });

  test("polls past 404s (row not written yet) until the signature appears", async () => {
    let n = 0;
    let slept = 0;
    const r = await pollSettlement({
      gatewayUrl: "https://gw.example",
      callId: VALID_CALL_ID,
      windowMs: 30_000,
      intervalMs: 3_000,
      sleep: async () => {
        slept += 1;
      },
      now: () => 0,
      fetchImpl: (async () => {
        n += 1;
        if (n < 3) return new Response(JSON.stringify({ error: "call not found" }), { status: 404 });
        return jsonResponse({
          callId: VALID_CALL_ID,
          signature: "LateSig",
          premiumLamports: "100",
          refundLamports: "0",
          breach: false,
          settledAt: "2026-05-12T00:00:03.000Z",
        });
      }) as unknown as typeof fetch,
    });
    expect(n).toBe(3);
    expect(slept).toBe(2);
    expect(r.kind).toBe("settled");
    if (r.kind === "settled") expect(r.call.signature).toBe("LateSig");
  });

  test("surfaces breach + refund fields", async () => {
    const r = await pollSettlement({
      gatewayUrl: "https://gw.example",
      callId: VALID_CALL_ID,
      sleep: async () => {},
      now: () => 0,
      fetchImpl: (async () =>
        jsonResponse({
          callId: VALID_CALL_ID,
          signature: "BreachSig",
          premiumLamports: "100",
          refundLamports: "1000000",
          breach: true,
          breachReason: "latency_exceeded",
          settledAt: "2026-05-12T00:00:08.000Z",
        })) as unknown as typeof fetch,
    });
    expect(r.kind).toBe("settled");
    if (r.kind !== "settled") throw new Error("unreachable");
    expect(r.call.breach).toBe(true);
    expect(r.call.breachReason).toBe("latency_exceeded");
    expect(r.call.refundUsdc).toBe(1);
  });

  test("returns pending when the window elapses without a signature", async () => {
    let t = 0;
    let polls = 0;
    const r = await pollSettlement({
      gatewayUrl: "https://gw.example",
      callId: VALID_CALL_ID,
      windowMs: 9_000,
      intervalMs: 3_000,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      fetchImpl: (async () => {
        polls += 1;
        // Always 200 but never a signature -> keeps polling within the window.
        return jsonResponse({ callId: VALID_CALL_ID });
      }) as unknown as typeof fetch,
    });
    expect(r.kind).toBe("pending");
    if (r.kind === "pending") expect(r.pollsAttempted).toBeGreaterThanOrEqual(2);
    // 9s window, 3s interval -> 2 polls (t=0, t=3000) then t+3000>=9000 ... actually
    // poll1 t=0 -> 0+3000<9000 sleep; poll2 t=3000 -> 3000+3000<9000 sleep; poll3 t=6000 -> 6000+3000>=9000 stop
    expect(polls).toBe(3);
  });

  test("returns pending and never fetches when the network is down the whole window", async () => {
    let t = 0;
    const r = await pollSettlement({
      gatewayUrl: "https://gw.example",
      callId: VALID_CALL_ID,
      windowMs: 6_000,
      intervalMs: 3_000,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(r.kind).toBe("pending");
  });

  test("skips when call_id is not a server-assigned UUIDv4", async () => {
    let fetched = false;
    const r = await pollSettlement({
      gatewayUrl: "https://gw.example",
      callId: "call_not-a-uuid",
      fetchImpl: (async () => {
        fetched = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(r.kind).toBe("skipped");
    expect(fetched).toBe(false);
  });

  test("solscanUrl builds the expected link", () => {
    expect(solscanUrl("AbC")).toBe("https://solscan.io/tx/AbC");
  });
});

import { applySettlementToMeta } from "../src/lib/settlement.ts";

describe("lib/settlement: applySettlementToMeta", () => {
  test("merges settled fields + solscan_url into meta and clears pending markers", () => {
    const meta: Record<string, unknown> = {
      slug: "helius",
      call_id: VALID_CALL_ID,
      call_id_source: "proxy",
      tx_signature: null,
      settlement_eta_sec: 8,
      premium_lamports: 0,
      premium_usdc: 0.0001,
      settlement_pending: true, // stale from a prior pass — must be cleared
    };
    const { ttyLine } = applySettlementToMeta(
      meta,
      {
        kind: "settled",
        call: {
          signature: "SiG777",
          premiumLamports: 250,
          premiumUsdc: 0.00025,
          refundLamports: 0,
          refundUsdc: 0,
          breach: false,
          breachReason: null,
          settledAt: "2026-05-12T01:02:03.000Z",
          latencyMs: 99,
        },
      },
      30,
    );
    expect(meta.tx_signature).toBe("SiG777");
    expect(meta.premium_lamports).toBe(250);
    expect(meta.premium_usdc).toBeCloseTo(0.00025, 9);
    expect(meta.refund_lamports).toBe(0);
    expect(meta.refund_usdc).toBe(0);
    expect(meta.breach).toBe(false);
    expect(meta.settled_at).toBe("2026-05-12T01:02:03.000Z");
    expect(meta.settled_latency_ms).toBe(99);
    expect(meta.solscan_url).toBe("https://solscan.io/tx/SiG777");
    expect(meta.settlement_pending).toBeUndefined();
    expect(ttyLine).toContain("settled on-chain: SiG777");
    expect(ttyLine).toContain("https://solscan.io/tx/SiG777");
  });

  test("on a breach, ttyLine mentions the refund and meta carries breach_reason", () => {
    const meta: Record<string, unknown> = { call_id: VALID_CALL_ID };
    const { ttyLine } = applySettlementToMeta(
      meta,
      {
        kind: "settled",
        call: {
          signature: "Br3ach",
          premiumLamports: 100,
          premiumUsdc: 0.0001,
          refundLamports: 1_000_000,
          refundUsdc: 1,
          breach: true,
          breachReason: "upstream_5xx",
          settledAt: "2026-05-12T01:00:00.000Z",
          latencyMs: null,
        },
      },
      30,
    );
    expect(meta.breach).toBe(true);
    expect(meta.breach_reason).toBe("upstream_5xx");
    expect(meta.refund_usdc).toBe(1);
    expect(ttyLine).toContain("refunded 1 USDC");
  });

  test("on pending, sets settlement_pending + a `pact calls show <id>` hint and leaves tx_signature null", () => {
    const meta: Record<string, unknown> = {
      call_id: VALID_CALL_ID,
      tx_signature: null,
    };
    const { ttyLine } = applySettlementToMeta(meta, { kind: "pending", pollsAttempted: 10 }, 30);
    expect(meta.settlement_pending).toBe(true);
    expect(meta.tx_signature).toBeNull();
    expect(String(meta.settlement_hint)).toContain(`pact calls show ${VALID_CALL_ID}`);
    expect(ttyLine).toContain("still pending after 30s");
  });

  test("on skipped (non-pollable call_id), still sets a pending marker", () => {
    const meta: Record<string, unknown> = {};
    applySettlementToMeta(meta, { kind: "skipped", reason: "local_fallback id" }, 30);
    expect(meta.settlement_pending).toBe(true);
    expect(String(meta.settlement_hint)).toContain("check the dashboard later");
  });
});
