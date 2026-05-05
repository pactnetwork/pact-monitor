import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Stable shared mock objects — rebuilt before each test so mutations in one test don't leak
const defaultEndpoint = {
  slug: "helius",
  flatPremiumLamports: 500n,
  percentBps: 10,
  slaLatencyMs: 1200,
  imputedCostLamports: 50000n,
  exposureCapPerHourLamports: 1000000n,
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  displayName: "Helius RPC",
};

const mockRegistry = { get: vi.fn(), size: 1 };
const mockDemoAllowlist = { has: vi.fn() };
const mockBalanceCache = { get: vi.fn(), size: 0 };
const mockPublisher = { publish: vi.fn() };

vi.mock("../src/lib/context.js", () => ({
  getContext: vi.fn(() => ({
    registry: mockRegistry,
    demoAllowlist: mockDemoAllowlist,
    operatorAllowlist: { has: vi.fn().mockResolvedValue(false) },
    balanceCache: mockBalanceCache,
    publisher: mockPublisher,
  })),
  initContext: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  env: {
    PG_URL: "postgresql://localhost/test",
    RPC_URL: "http://localhost:8899",
    PROGRAM_ID: "11111111111111111111111111111111",
    PUBSUB_PROJECT: "test-project",
    PUBSUB_TOPIC: "pact-settle-events",
    ENDPOINTS_RELOAD_TOKEN: "test-token-1234567890",
    PORT: "8080",
  },
}));

// Mock global fetch for upstream calls
const mockUpstreamFetch = vi.fn();
vi.stubGlobal("fetch", mockUpstreamFetch);

import { proxyRoute } from "../src/routes/proxy.js";
import { getContext } from "../src/lib/context.js";

function makeApp() {
  const app = new Hono();
  app.all("/v1/:slug/*", proxyRoute);
  return app;
}

describe("proxy route", () => {
  beforeEach(() => {
    // Reset to defaults before each test
    mockRegistry.get.mockResolvedValue({ ...defaultEndpoint });
    mockDemoAllowlist.has.mockResolvedValue(false);
    mockBalanceCache.get.mockResolvedValue(100_000_000n);
    mockPublisher.publish.mockResolvedValue(undefined);
    mockUpstreamFetch.mockResolvedValue(
      new Response(JSON.stringify({ result: { value: 100 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  test("happy path — returns upstream response with X-Pact headers", async () => {
    const app = makeApp();
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] });
    const resp = await app.request("/v1/helius/?pact_wallet=wallet123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Pact-Outcome")).toBe("ok");
    expect(resp.headers.get("X-Pact-Breach")).toBe("0");
    expect(resp.headers.get("X-Pact-Call-Id")).toBeTruthy();
  });

  test("404 when endpoint slug not found", async () => {
    const ctx = getContext() as any;
    ctx.registry.get.mockResolvedValue(undefined);
    const app = makeApp();
    const resp = await app.request("/v1/unknown/?pact_wallet=wallet123", {
      method: "POST",
      body: "{}",
    });
    expect(resp.status).toBe(404);
  });

  test("402 when balance insufficient", async () => {
    const ctx = getContext() as any;
    ctx.balanceCache.get.mockResolvedValue(100n); // less than 500 lamports premium
    const app = makeApp();
    const resp = await app.request("/v1/helius/?pact_wallet=poorwallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] }),
    });
    expect(resp.status).toBe(402);
  });

  test("503 when endpoint paused", async () => {
    mockRegistry.get.mockResolvedValue({ ...defaultEndpoint, paused: true });
    const app = makeApp();
    const resp = await app.request("/v1/helius/?pact_wallet=wallet123", {
      method: "POST",
      body: "{}",
    });
    expect(resp.status).toBe(503);
  });

  test("passthrough (no pact_wallet) — no X-Pact headers", async () => {
    const app = makeApp();
    const resp = await app.request("/v1/helius/", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Pact-Outcome")).toBeNull();
  });

  test("force-breach path marks outcome as server_error when wallet allowlisted", async () => {
    const ctx = getContext() as any;
    ctx.demoAllowlist.has.mockResolvedValue(true);
    vi.useFakeTimers();

    const app = makeApp();
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] });
    const promise = app.request("/v1/helius/?pact_wallet=allowed&demo_breach=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await vi.runAllTimersAsync();
    const resp = await promise;
    expect(resp.headers.get("X-Pact-Breach")).toBe("1");
    expect(resp.headers.get("X-Pact-Outcome")).toBe("server_error");
    vi.useRealTimers();
  });
});
