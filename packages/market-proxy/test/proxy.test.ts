// Integration test for the proxy route after the wrap-library refactor.
//
// We mock:
//   - the AppContext (registry, demo allowlist, balanceCheck, sink)
//   - global fetch (upstream provider)
//
// We assert:
//   - happy path returns the upstream response with X-Pact-* headers
//     applied by wrap's attachPactHeaders
//   - the wrap library is called and emits a SettlementEvent into the sink
//   - the per-provider classifier (Helius) is composed correctly with the
//     default classifier
//   - 402 returned when balance/allowance insufficient
//   - 503 when endpoint paused, 404 when slug unknown
//   - passthrough (no pact_wallet) bypasses wrap entirely
//   - force-breach mode causes wrap to classify as latency_breach

import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { MemoryEventSink, type BalanceCheck } from "@pact-network/wrap";

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
const mockBalanceCheck: BalanceCheck = {
  check: vi.fn(),
};
const memorySink = new MemoryEventSink();

vi.mock("../src/lib/context.js", () => ({
  getContext: vi.fn(() => ({
    registry: mockRegistry,
    demoAllowlist: mockDemoAllowlist,
    operatorAllowlist: { has: vi.fn().mockResolvedValue(false) },
    balanceCheck: mockBalanceCheck,
    sink: memorySink,
  })),
  initContext: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  env: {
    PG_URL: "postgresql://localhost/test",
    RPC_URL: "http://localhost:8899",
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    PUBSUB_PROJECT: "test-project",
    PUBSUB_TOPIC: "pact-settle-events",
    ENDPOINTS_RELOAD_TOKEN: "test-token-1234567890",
    PORT: "8080",
  },
}));

const mockUpstreamFetch = vi.fn();
vi.stubGlobal("fetch", mockUpstreamFetch);

import { proxyRoute } from "../src/routes/proxy.js";
import { getContext } from "../src/lib/context.js";

function makeApp() {
  const app = new Hono();
  app.all("/v1/:slug/*", proxyRoute);
  return app;
}

describe("proxy route (wrap-based)", () => {
  beforeEach(() => {
    mockRegistry.get.mockResolvedValue({ ...defaultEndpoint });
    mockDemoAllowlist.has.mockResolvedValue(false);
    (mockBalanceCheck.check as any) = vi.fn().mockResolvedValue({
      eligible: true,
      ataBalance: 100_000_000n,
      allowance: 100_000_000n,
    });
    memorySink.reset();
    mockUpstreamFetch.mockResolvedValue(
      new Response(JSON.stringify({ result: { value: 100 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  test("happy path — returns upstream response with X-Pact headers", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    const resp = await app.request("/v1/helius/?pact_wallet=wallet123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Pact-Outcome")).toBe("ok");
    expect(resp.headers.get("X-Pact-Premium")).toBe("500");
    expect(resp.headers.get("X-Pact-Refund")).toBe("0");
    expect(resp.headers.get("X-Pact-Call-Id")).toBeTruthy();
  });

  test("wrap is called with correct opts and a settlement event is emitted", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    await app.request("/v1/helius/?pact_wallet=wallet-A", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // Allow microtasks to flush — wrap publishes fire-and-forget.
    await new Promise((r) => setImmediate(r));
    expect(memorySink.events.length).toBe(1);
    const ev = memorySink.events[0];
    expect(ev.endpointSlug).toBe("helius");
    expect(ev.agentPubkey).toBe("wallet-A");
    expect(ev.outcome).toBe("ok");
    expect(ev.premiumLamports).toBe("500");
  });

  test("Helius JSON-RPC error -32603 → server_error settlement", async () => {
    mockUpstreamFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    const resp = await app.request("/v1/helius/?pact_wallet=walletJrpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(resp.headers.get("X-Pact-Outcome")).toBe("server_error");
    expect(resp.headers.get("X-Pact-Refund")).toBe("50000");
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

  test("402 when balance insufficient (ATA balance < required)", async () => {
    (mockBalanceCheck.check as any) = vi.fn().mockResolvedValue({
      eligible: false,
      reason: "insufficient_balance",
      ataBalance: 100n,
      allowance: 100n,
    });
    const app = makeApp();
    const resp = await app.request("/v1/helius/?pact_wallet=poorwallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] }),
    });
    expect(resp.status).toBe(402);
  });

  test("402 when allowance insufficient (delegated_amount < required)", async () => {
    (mockBalanceCheck.check as any) = vi.fn().mockResolvedValue({
      eligible: false,
      reason: "insufficient_allowance",
      ataBalance: 1_000_000n,
      allowance: 100n,
    });
    const app = makeApp();
    const resp = await app.request("/v1/helius/?pact_wallet=noallowance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] }),
    });
    expect(resp.status).toBe(402);
    const json = (await resp.json()) as { reason: string };
    expect(json.reason).toBe("insufficient_allowance");
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

  test("passthrough (no pact_wallet) — no X-Pact headers, no settlement event", async () => {
    const app = makeApp();
    const resp = await app.request("/v1/helius/", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Pact-Outcome")).toBeNull();
    expect(memorySink.events.length).toBe(0);
  });

  // Alan review M2: upstream Set-Cookie / Server / Access-Control-* must
  // not leak through; proxy applies its own permissive CORS and X-Pact-*
  // headers come through.
  test("strips upstream Set-Cookie/Server/CORS leaks; X-Pact-* still added", async () => {
    mockUpstreamFetch.mockResolvedValue(
      new Response(JSON.stringify({ result: { value: 100 } }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "leak=yes; HttpOnly",
          Server: "cloudflare",
          "X-Powered-By": "Express",
          "Access-Control-Allow-Origin": "https://attacker.example.com",
          "Access-Control-Allow-Credentials": "true",
        },
      }),
    );
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    const resp = await app.request("/v1/helius/?pact_wallet=walletM2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // Stripped:
    expect(resp.headers.get("set-cookie")).toBeNull();
    expect(resp.headers.get("server")).toBeNull();
    expect(resp.headers.get("x-powered-by")).toBeNull();
    expect(resp.headers.get("access-control-allow-credentials")).toBeNull();
    // Proxy CORS:
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    // X-Pact-* still present:
    expect(resp.headers.get("X-Pact-Outcome")).toBe("ok");
    expect(resp.headers.get("X-Pact-Call-Id")).toBeTruthy();
  });

  // Alan review M2: even on the uninsured passthrough (no pact_wallet),
  // upstream Set-Cookie must not leak through.
  test("passthrough also strips upstream Set-Cookie", async () => {
    mockUpstreamFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "leak=yes",
          Server: "nginx",
        },
      }),
    );
    const app = makeApp();
    const resp = await app.request("/v1/helius/", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] }),
    });
    expect(resp.headers.get("set-cookie")).toBeNull();
    expect(resp.headers.get("server")).toBeNull();
  });

  // Issue #158: the CLI transmits the agent pubkey in the `x-pact-agent`
  // header. The proxy must enter the insured branch on header alone, not
  // require the legacy `pact_wallet` query param.
  test("x-pact-agent header enters the insured wrap path (no query param)", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    const resp = await app.request("/v1/helius/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pact-agent": "wallet-from-header",
      },
      body,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Pact-Outcome")).toBe("ok");
    expect(resp.headers.get("X-Pact-Premium")).toBe("500");
    expect(resp.headers.get("X-Pact-Call-Id")).toBeTruthy();
    // Allow the fire-and-forget sink publish to flush.
    await new Promise((r) => setImmediate(r));
    expect(memorySink.events.length).toBe(1);
    expect(memorySink.events[0].agentPubkey).toBe("wallet-from-header");
  });

  // Back-compat: the dashboard demo path still uses `pact_wallet=...` query
  // param. That surface must keep working until it migrates.
  test("pact_wallet query param remains supported (back-compat)", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    const resp = await app.request("/v1/helius/?pact_wallet=legacy-wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Pact-Outcome")).toBe("ok");
    await new Promise((r) => setImmediate(r));
    expect(memorySink.events[0].agentPubkey).toBe("legacy-wallet");
  });

  // If both are present, the header wins. The CLI is the source of truth
  // for an authenticated identity; the query param is the legacy surface.
  test("x-pact-agent header takes precedence over pact_wallet query param", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    const resp = await app.request("/v1/helius/?pact_wallet=legacy-wallet", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pact-agent": "header-wallet",
      },
      body,
    });
    expect(resp.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(memorySink.events[0].agentPubkey).toBe("header-wallet");
  });

  test("force-breach mode forces a latency_breach classification", async () => {
    const ctx = getContext() as any;
    ctx.demoAllowlist.has.mockResolvedValue(true);
    vi.useFakeTimers();

    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: [],
    });
    const promise = app.request(
      "/v1/helius/?pact_wallet=allowed&demo_breach=1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    // Advance past sla (1200) + 300 = 1500ms slept by force-breach.
    await vi.advanceTimersByTimeAsync(1700);
    const resp = await promise;
    expect(resp.headers.get("X-Pact-Outcome")).toBe("latency_breach");
    expect(resp.headers.get("X-Pact-Refund")).toBe("50000");
    vi.useRealTimers();
  });
});
