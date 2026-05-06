import { describe, it, expect, vi } from "vitest";
import { wrapFetch } from "../wrapFetch";
import { defaultClassifier } from "../classifier";
import { MemoryEventSink } from "../eventSink";
import { HEADERS } from "../headers";
import type { BalanceCheck } from "../balanceCheck";
import type { EndpointConfig } from "../types";

const cfg: EndpointConfig = {
  slug: "helius",
  sla_latency_ms: 500,
  flat_premium_lamports: 1_000n,
  imputed_cost_lamports: 10_000n,
};

const baseOpts = (overrides: Partial<Parameters<typeof wrapFetch>[0]> = {}) => ({
  endpointSlug: "helius",
  walletPubkey: "Wallet111",
  upstreamUrl: "https://upstream.test/rpc",
  classifier: defaultClassifier,
  sink: new MemoryEventSink(),
  endpointConfig: cfg,
  ...overrides,
});

/** Build a fetch impl that returns a fixed response and reports `latencyMs`. */
function timedFetch(status: number, latencyMs: number, body: string = "ok") {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls++;
    return new Response(body, { status });
  });
  return { fetchImpl, getCalls: () => calls, latencyMs };
}

/**
 * A clock helper that returns t_start on first read and t_start+latencyMs on
 * the second read — matching wrapFetch's ordering of `now()` calls around
 * the upstream fetch.
 */
function clockFromFetch(fetchProbe: { latencyMs: number }) {
  let calls = 0;
  return {
    now: () => {
      const t = calls === 0 ? 1_000 : 1_000 + fetchProbe.latencyMs;
      calls++;
      return t;
    },
  };
}

describe("wrapFetch", () => {
  it("happy path: 2xx within sla → ok, premium=flat, refund=0, headers attached", async () => {
    const sink = new MemoryEventSink();
    const probe = timedFetch(200, 100);
    const clock = clockFromFetch(probe);
    const r = await wrapFetch(
      baseOpts({ sink, fetchImpl: probe.fetchImpl, now: clock.now }),
    );
    expect(r.outcome).toBe("ok");
    expect(r.premiumLamports).toBe(1_000n);
    expect(r.refundLamports).toBe(0n);
    expect(r.latencyMs).toBe(100);
    expect(r.callId).toMatch(/[a-f0-9-]/i);
    expect(r.response.status).toBe(200);
    expect(r.response.headers.get(HEADERS.OUTCOME)).toBe("ok");
    expect(r.response.headers.get(HEADERS.PREMIUM)).toBe("1000");
    expect(r.response.headers.get(HEADERS.LATENCY_MS)).toBe("100");
    expect(r.response.headers.get(HEADERS.SETTLEMENT_PENDING)).toBe("1");
    // Flush microtasks for fire-and-forget sink.
    await new Promise((res) => setImmediate(res));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].outcome).toBe("ok");
    expect(sink.events[0].premiumLamports).toBe("1000");
    expect(sink.events[0].callId).toBe(r.callId);
  });

  it("latency breach: 2xx but slow → latency_breach, refund=imputed", async () => {
    const sink = new MemoryEventSink();
    const probe = timedFetch(200, 700);
    const clock = clockFromFetch(probe);
    const r = await wrapFetch(
      baseOpts({ sink, fetchImpl: probe.fetchImpl, now: clock.now }),
    );
    expect(r.outcome).toBe("latency_breach");
    expect(r.refundLamports).toBe(10_000n);
    expect(r.latencyMs).toBe(700);
  });

  it("5xx → server_error, refund=imputed, premium=flat", async () => {
    const sink = new MemoryEventSink();
    const probe = timedFetch(503, 50);
    const clock = clockFromFetch(probe);
    const r = await wrapFetch(
      baseOpts({ sink, fetchImpl: probe.fetchImpl, now: clock.now }),
    );
    expect(r.outcome).toBe("server_error");
    expect(r.premiumLamports).toBe(1_000n);
    expect(r.refundLamports).toBe(10_000n);
    expect(r.response.status).toBe(503);
  });

  it("429 → client_error, premium=0, refund=0", async () => {
    const probe = timedFetch(429, 30);
    const clock = clockFromFetch(probe);
    const r = await wrapFetch(
      baseOpts({ fetchImpl: probe.fetchImpl, now: clock.now }),
    );
    expect(r.outcome).toBe("client_error");
    expect(r.premiumLamports).toBe(0n);
    expect(r.refundLamports).toBe(0n);
  });

  it("network error → server_error path with synthesized 502 response", async () => {
    const sink = new MemoryEventSink();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    let t = 1_000;
    const r = await wrapFetch(
      baseOpts({
        sink,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => {
          const v = t;
          t += 200;
          return v;
        },
      }),
    );
    expect(r.outcome).toBe("network_error");
    expect(r.response.status).toBe(502);
    expect(r.premiumLamports).toBe(1_000n);
    expect(r.refundLamports).toBe(10_000n);
    await new Promise((res) => setImmediate(res));
    expect(sink.events[0].outcome).toBe("network_error");
  });

  it("balance check rejected (insufficient_balance) → 402 short-circuit, no upstream call, no event", async () => {
    const sink = new MemoryEventSink();
    const fetchImpl = vi.fn();
    const balanceCheck: BalanceCheck = {
      check: async () => ({
        eligible: false,
        reason: "insufficient_balance",
        ataBalance: 0n,
        allowance: 0n,
      }),
    };
    const r = await wrapFetch(
      baseOpts({
        sink,
        balanceCheck,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(r.response.status).toBe(402);
    expect(r.outcome).toBe("client_error");
    expect(r.premiumLamports).toBe(0n);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = await r.response.json();
    expect(body.error).toBe("payment_required");
    expect(body.reason).toBe("insufficient_balance");
    // No settlement event because nothing was attempted upstream.
    await new Promise((res) => setImmediate(res));
    expect(sink.events).toHaveLength(0);
  });

  it("balance check eligible → upstream is called", async () => {
    const probe = timedFetch(200, 100);
    const clock = clockFromFetch(probe);
    const balanceCheck: BalanceCheck = {
      check: async () => ({
        eligible: true,
        ataBalance: 100_000n,
        allowance: 100_000n,
      }),
    };
    const r = await wrapFetch(
      baseOpts({
        balanceCheck,
        fetchImpl: probe.fetchImpl,
        now: clock.now,
      }),
    );
    expect(r.outcome).toBe("ok");
    expect(probe.getCalls()).toBe(1);
  });

  it("balance check throws → 503 with no upstream call and no event", async () => {
    const sink = new MemoryEventSink();
    const fetchImpl = vi.fn();
    const balanceCheck: BalanceCheck = {
      check: async () => {
        throw new Error("rpc broke");
      },
    };
    const r = await wrapFetch(
      baseOpts({
        sink,
        balanceCheck,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(r.response.status).toBe(503);
    expect(r.outcome).toBe("server_error");
    expect(fetchImpl).not.toHaveBeenCalled();
    await new Promise((res) => setImmediate(res));
    expect(sink.events).toHaveLength(0);
  });

  it("sink.publish failure is swallowed (does not break wrap)", async () => {
    const probe = timedFetch(200, 100);
    const clock = clockFromFetch(probe);
    const sink = {
      publish: vi.fn().mockRejectedValue(new Error("sink down")),
    };
    const r = await wrapFetch(
      baseOpts({
        sink,
        fetchImpl: probe.fetchImpl,
        now: clock.now,
      }),
    );
    expect(r.outcome).toBe("ok");
    expect(r.response.status).toBe(200);
    // Wait so the rejection settles without unhandled rejection.
    await new Promise((res) => setImmediate(res));
    expect(sink.publish).toHaveBeenCalledTimes(1);
  });

  it("sink.publish synchronous throw is swallowed", async () => {
    const probe = timedFetch(200, 100);
    const clock = clockFromFetch(probe);
    const sink = {
      publish: vi.fn(() => {
        throw new Error("sync sink error");
      }),
    };
    const r = await wrapFetch(
      baseOpts({
        sink,
        fetchImpl: probe.fetchImpl,
        now: clock.now,
      }),
    );
    expect(r.outcome).toBe("ok");
  });

  it("each call gets a unique callId", async () => {
    const probe = timedFetch(200, 100);
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = await wrapFetch(
        baseOpts({
          fetchImpl: probe.fetchImpl,
          now: () => 1000,
        }),
      );
      ids.add(r.callId);
    }
    expect(ids.size).toBe(50);
  });

  it("respects an injected callId", async () => {
    const probe = timedFetch(200, 50);
    const clock = clockFromFetch(probe);
    const r = await wrapFetch(
      baseOpts({
        callId: "fixed-id-99",
        fetchImpl: probe.fetchImpl,
        now: clock.now,
      }),
    );
    expect(r.callId).toBe("fixed-id-99");
    expect(r.response.headers.get("X-Pact-Call-Id")).toBe("fixed-id-99");
  });

  it("attaches X-Pact-Pool when pool is provided", async () => {
    const probe = timedFetch(200, 100);
    const clock = clockFromFetch(probe);
    const r = await wrapFetch(
      baseOpts({
        pool: "helius-mainnet",
        fetchImpl: probe.fetchImpl,
        now: clock.now,
      }),
    );
    expect(r.response.headers.get(HEADERS.POOL)).toBe("helius-mainnet");
  });

  it("forwards init (method, body, headers) to upstream", async () => {
    const fetchImpl = vi.fn(async (_url: any, init?: any) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers?.["x-test"]).toBe("yes");
      expect(init?.body).toBe("payload");
      return new Response("", { status: 200 });
    });
    let t = 1_000;
    await wrapFetch(
      baseOpts({
        init: {
          method: "POST",
          headers: { "x-test": "yes" },
          body: "payload",
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => {
          const v = t;
          t += 50;
          return v;
        },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://upstream.test/rpc",
      expect.objectContaining({ method: "POST", body: "payload" }),
    );
  });

  it("settlement event timestamp is ISO-8601 and corresponds to t_end", async () => {
    const sink = new MemoryEventSink();
    const probe = timedFetch(200, 100);
    let t = 1_700_000_000_000; // a real-looking ms epoch
    await wrapFetch(
      baseOpts({
        sink,
        fetchImpl: probe.fetchImpl,
        now: () => {
          const v = t;
          t += probe.latencyMs;
          return v;
        },
      }),
    );
    await new Promise((res) => setImmediate(res));
    expect(sink.events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // t_end = t_start + latency = 1_700_000_000_000 + 100.
    const parsed = new Date(sink.events[0].ts).getTime();
    expect(parsed).toBe(1_700_000_000_100);
  });
});
