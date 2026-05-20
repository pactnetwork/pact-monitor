import { describe, it, expect } from "vitest";
import { SlugResolver, type DiscoveryResponse } from "../slug-resolver.js";

function discovery(): DiscoveryResponse {
  return {
    cacheTtlSec: 3600,
    endpoints: [
      {
        slug: "helius",
        hostnames: ["api.helius.xyz", "mainnet.helius-rpc.com"],
        premiumBps: 100,
        paused: false,
      },
      {
        slug: "dummy",
        hostnames: ["dummy.pactnetwork.io"],
        premiumBps: 100,
        paused: false,
      },
      {
        slug: "paused-svc",
        hostnames: ["paused.example.com"],
        premiumBps: 50,
        paused: true,
      },
    ],
  };
}

function makeFetch(
  payload: DiscoveryResponse | (() => Response),
): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (typeof payload === "function") return payload();
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

describe("SlugResolver", () => {
  it("resolves a known hostname to its slug", async () => {
    const { fetchImpl } = makeFetch(discovery());
    const r = new SlugResolver({ proxyBaseUrl: "https://p", fetchImpl });
    const res = await r.resolve("api.helius.xyz");
    expect(res).toEqual({
      ok: true,
      entry: { slug: "helius", premiumBps: 100, paused: false },
    });
  });

  it("reports a paused endpoint as not-ok", async () => {
    const { fetchImpl } = makeFetch(discovery());
    const r = new SlugResolver({ proxyBaseUrl: "https://p", fetchImpl });
    const res = await r.resolve("paused.example.com");
    expect(res).toEqual({
      ok: false,
      reason: "paused",
      hostname: "paused.example.com",
    });
  });

  it("returns unregistered for an unknown host and negative-caches it", async () => {
    const { fetchImpl, calls } = makeFetch(discovery());
    const r = new SlugResolver({ proxyBaseUrl: "https://p", fetchImpl });
    const a = await r.resolve("unknown.example.com");
    const b = await r.resolve("unknown.example.com");
    expect(a).toEqual({
      ok: false,
      reason: "unregistered",
      hostname: "unknown.example.com",
    });
    expect(b.ok).toBe(false);
    // Second lookup served from negative cache — no extra discovery fetch.
    expect(calls()).toBe(1);
  });

  it("dedupes concurrent discovery refreshes into one fetch", async () => {
    const { fetchImpl, calls } = makeFetch(discovery());
    const r = new SlugResolver({ proxyBaseUrl: "https://p", fetchImpl });
    const [x, y, z] = await Promise.all([
      r.resolve("api.helius.xyz"),
      r.resolve("dummy.pactnetwork.io"),
      r.resolve("mainnet.helius-rpc.com"),
    ]);
    expect(x.ok && y.ok && z.ok).toBe(true);
    expect(calls()).toBe(1);
  });

  it("falls back to stale cache when discovery becomes unreachable", async () => {
    const state = { clock: 0, fail: false };
    const r = new SlugResolver({
      proxyBaseUrl: "https://p",
      now: () => state.clock,
      fetchImpl: (async () => {
        if (state.fail) throw new Error("network down");
        return new Response(JSON.stringify(discovery()), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const first = await r.resolve("api.helius.xyz");
    expect(first.ok).toBe(true);
    state.fail = true;
    state.clock = 3_600_001; // expire the 1h TTL so resolve() refreshes
    const second = await r.resolve("api.helius.xyz");
    expect(second.ok).toBe(true); // served from stale good cache
  });

  it("returns discovery_failed when unreachable and no cache exists", async () => {
    const r = new SlugResolver({
      proxyBaseUrl: "https://p",
      fetchImpl: (async () => {
        throw new Error("dns");
      }) as unknown as typeof fetch,
    });
    const res = await r.resolve("api.helius.xyz");
    expect(res).toEqual({
      ok: false,
      reason: "discovery_failed",
      hostname: "api.helius.xyz",
    });
  });

  it("treats a non-200 discovery response as a failed refresh", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("nope", { status: 503 }),
    );
    const r = new SlugResolver({ proxyBaseUrl: "https://p", fetchImpl });
    const res = await r.resolve("api.helius.xyz");
    expect(res.ok).toBe(false);
  });
});
