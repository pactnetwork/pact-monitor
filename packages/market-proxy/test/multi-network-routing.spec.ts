/**
 * multi-network-routing.spec.ts — WP-MN-03b T5
 *
 * Tests the proxy's adapter-dispatch logic:
 *   1. solana-devnet endpoint routes to SolanaAdapter (or legacy under flag)
 *   2. arc-testnet endpoint routes to EvmAdapterStub → 502 not-implemented
 *      (the stub throws; wrap surfaces a 502 or the adapter error propagates)
 *   3. endpoint with unknown/unenabled network → 503 "not enabled on this proxy"
 *      (per the Step 3 fix in WP-MN-03b T5 — explicit error, no silent fallback)
 *
 * Approach: we unit-test the routing decision (which balanceCheck is selected)
 * via the proxy route function with a fully-controlled AppContext injected via
 * setContext(). This avoids Postgres / RPC / Pub/Sub dependencies.
 *
 * The proxy route is the single authoritative routing point; testing it end-to-
 * end through the Hono app is the most faithful assertion of production behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { MemoryEventSink, type BalanceCheck } from "@pact-network/wrap";

// ---------------------------------------------------------------------------
// Mock env + context to avoid Postgres / RPC at import time
// ---------------------------------------------------------------------------

vi.mock("../src/env.js", () => ({
  env: {
    PG_URL: "postgres://localhost:5432/test",
    RPC_URL: "https://api.devnet.solana.com",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    QUEUE_BACKEND: "redis",
    PUBSUB_PROJECT: "",
    PUBSUB_TOPIC: "",
    REDIS_URL: "redis://localhost:6379",
    REDIS_STREAM: "pact-events",
    ADMIN_BEARER: "test-bearer",
    PACT_BETA_GATE_ENABLED: false,
  },
}));

// ---------------------------------------------------------------------------
// Shared mocks for proxy test dependencies
// ---------------------------------------------------------------------------

const mockRegistry = { get: vi.fn() };
const mockDemoAllowlist = { has: vi.fn().mockResolvedValue(false) };
const memorySink = new MemoryEventSink();

// Legacy balance check — used when legacyDirectSolana=true or as reference.
const legacyBalanceCheck: BalanceCheck = {
  check: vi.fn().mockResolvedValue({
    eligible: true,
    ataBalance: 100_000_000n,
    allowance: 100_000_000n,
  }),
};

// Solana adapter stub — implements checkAgentEligibility (used by adapterToBalanceCheck).
const solanaAdapterStub = {
  checkAgentEligibility: vi.fn().mockResolvedValue({
    eligible: true,
    balance: 100_000_000n,
    allowance: 100_000_000n,
  }),
  submitSettleBatch: vi.fn(),
};

// EVM adapter stub — checkAgentEligibility throws "not implemented".
const evmAdapterStub = {
  checkAgentEligibility: vi.fn().mockRejectedValue(
    new Error("EvmAdapterStub: checkAgentEligibility not implemented"),
  ),
  submitSettleBatch: vi.fn().mockRejectedValue(
    new Error("EvmAdapterStub: submitSettleBatch not implemented"),
  ),
};

// Mock upstream fetch — used by the passthrough paths.
const mockUpstreamFetch = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
);
vi.stubGlobal("fetch", mockUpstreamFetch);

// Base endpoint fixture — network is overridden per test.
const baseEndpoint = {
  slug: "helius",
  network: "solana-devnet",
  flatPremiumLamports: 500n,
  percentBps: 0,
  slaLatencyMs: 1200,
  imputedCostLamports: 50000n,
  exposureCapPerHourLamports: 1_000_000n,
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  displayName: "Helius RPC",
};

// ---------------------------------------------------------------------------
// Build a Hono app with the given AppContext injected via setContext.
// ---------------------------------------------------------------------------

import { proxyRoute } from "../src/routes/proxy.js";
import { setContext } from "../src/lib/context.js";

function makeApp(ctx: Parameters<typeof setContext>[0]) {
  setContext(ctx);
  const app = new Hono();
  app.all("/v1/:slug/*", proxyRoute);
  return app;
}

function makeContext(overrides: {
  network?: string;
  adapters?: Map<string, object>;
  legacyDirectSolana?: boolean;
}) {
  return {
    registry: mockRegistry,
    demoAllowlist: mockDemoAllowlist,
    operatorAllowlist: { has: vi.fn().mockResolvedValue(false) },
    balanceCheck: legacyBalanceCheck,
    sink: memorySink,
    pg: {} as never,
    betaGateFlag: {} as never,
    adapters: overrides.adapters ?? new Map([["solana-devnet", solanaAdapterStub]]),
    legacyDirectSolana: overrides.legacyDirectSolana ?? false,
  };
}

const HELIUS_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "getAccountInfo",
  params: [],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WP-MN-03b — multi-network routing", () => {
  beforeEach(() => {
    mockRegistry.get.mockReset();
    mockDemoAllowlist.has.mockReset().mockResolvedValue(false);
    (legacyBalanceCheck.check as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({
      eligible: true,
      ataBalance: 100_000_000n,
      allowance: 100_000_000n,
    });
    solanaAdapterStub.checkAgentEligibility.mockReset().mockResolvedValue({
      eligible: true,
      balance: 100_000_000n,
      allowance: 100_000_000n,
    });
    evmAdapterStub.checkAgentEligibility.mockReset().mockRejectedValue(
      new Error("EvmAdapterStub: checkAgentEligibility not implemented"),
    );
    mockUpstreamFetch.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    memorySink.reset();
    process.env.PACT_PROXY_INSECURE_DEMO = "1";
  });

  // -------------------------------------------------------------------------
  // Test 1: solana-devnet endpoint routes to SolanaAdapter
  // -------------------------------------------------------------------------
  it("solana-devnet endpoint routes to SolanaAdapter when legacyDirectSolana=false", async () => {
    mockRegistry.get.mockResolvedValue({
      ...baseEndpoint,
      network: "solana-devnet",
    });

    const adapters = new Map<string, object>([["solana-devnet", solanaAdapterStub]]);
    const app = makeApp(makeContext({ network: "solana-devnet", adapters, legacyDirectSolana: false }));

    const resp = await app.request("/v1/helius/?pact_wallet=wallet1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: HELIUS_BODY,
    });

    // solanaAdapterStub.checkAgentEligibility was called (adapter path active).
    expect(solanaAdapterStub.checkAgentEligibility).toHaveBeenCalled();
    // legacyBalanceCheck must NOT have been called (it was bypassed by the adapter).
    expect(legacyBalanceCheck.check).not.toHaveBeenCalled();
    // Response reaches upstream or wraps correctly.
    expect(resp.status).toBe(200);
  });

  it("solana-devnet endpoint uses legacyBalanceCheck when legacyDirectSolana=true", async () => {
    mockRegistry.get.mockResolvedValue({
      ...baseEndpoint,
      network: "solana-devnet",
    });

    const adapters = new Map<string, object>([["solana-devnet", solanaAdapterStub]]);
    const app = makeApp(makeContext({ network: "solana-devnet", adapters, legacyDirectSolana: true }));

    const resp = await app.request("/v1/helius/?pact_wallet=wallet-legacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: HELIUS_BODY,
    });

    // Legacy path: legacyBalanceCheck.check is called, adapter is bypassed.
    expect(legacyBalanceCheck.check).toHaveBeenCalled();
    expect(solanaAdapterStub.checkAgentEligibility).not.toHaveBeenCalled();
    expect(resp.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Test 2: arc-testnet endpoint routes to EvmAdapterStub (adapter found but
  // throws → surfaces as 503 balance_check_failed from wrapFetch, not the
  // "not enabled on this proxy" 503 from Step 3).
  //
  // wrapFetch catches balance-check infrastructure failures and returns 503
  // with json { error: "balance_check_failed" } — different from the plain-
  // text "not enabled on this proxy" 503 emitted by the routing guard. The
  // key assertion is: adapter WAS called and the 503 body is balance_check_failed.
  // -------------------------------------------------------------------------
  it("arc-testnet endpoint routes to EvmAdapterStub → 503 balance_check_failed (adapter reached, threw)", async () => {
    mockRegistry.get.mockResolvedValue({
      ...baseEndpoint,
      slug: "helius", // slug still 'helius' for handler registry lookup
      network: "arc-testnet",
    });

    const adapters = new Map<string, object>([
      ["solana-devnet", solanaAdapterStub],
      ["arc-testnet", evmAdapterStub],
    ]);
    const app = makeApp(makeContext({ network: "arc-testnet", adapters, legacyDirectSolana: false }));

    const resp = await app.request("/v1/helius/?pact_wallet=wallet-arc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: HELIUS_BODY,
    });

    // EVM adapter was reached (routing dispatched to it, not a silent fallback).
    expect(evmAdapterStub.checkAgentEligibility).toHaveBeenCalled();
    expect(solanaAdapterStub.checkAgentEligibility).not.toHaveBeenCalled();

    // wrapFetch surfaces adapter errors as 503 balance_check_failed (JSON body).
    // This is a DIFFERENT 503 from the routing-guard "not enabled on this proxy"
    // which returns plain text. Verify the adapter-dispatch path was followed
    // by checking the JSON body.
    expect(resp.status).toBe(503);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("balance_check_failed");
    // The plain-text "not enabled" 503 is NOT what we got here.
    // (If it were, json.error would be undefined and json.parse would throw.)
  });

  // -------------------------------------------------------------------------
  // Test 3: endpoint with unknown/unenabled network → 503
  // (THE KEY T5 FIX: silent fallback removed, explicit 503 + WARN log)
  // -------------------------------------------------------------------------
  it("endpoint with unenabled network → 503 'not enabled on this proxy'", async () => {
    mockRegistry.get.mockResolvedValue({
      ...baseEndpoint,
      network: "arc-testnet", // arc-testnet NOT in PACT_ENABLED_NETWORKS
    });

    // adapters only has solana-devnet — arc-testnet is NOT present.
    const adapters = new Map<string, object>([["solana-devnet", solanaAdapterStub]]);
    const app = makeApp(makeContext({ adapters, legacyDirectSolana: false }));

    const resp = await app.request("/v1/helius/?pact_wallet=wallet-unknown-net", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: HELIUS_BODY,
    });

    expect(resp.status).toBe(503);
    const body = await resp.text();
    expect(body).toContain("not enabled on this proxy");

    // No adapter or balance check was called — fail-fast before any chain touch.
    expect(evmAdapterStub.checkAgentEligibility).not.toHaveBeenCalled();
    expect(solanaAdapterStub.checkAgentEligibility).not.toHaveBeenCalled();
    expect(legacyBalanceCheck.check).not.toHaveBeenCalled();
  });

  it("endpoint with completely unknown network (not in adapters, not solana-*) → 503", async () => {
    mockRegistry.get.mockResolvedValue({
      ...baseEndpoint,
      network: "bogus-chain-99",
    });

    // Empty adapter map — nothing enabled.
    const adapters = new Map<string, object>();
    const app = makeApp(makeContext({ adapters, legacyDirectSolana: false }));

    const resp = await app.request("/v1/helius/?pact_wallet=wallet-bogus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: HELIUS_BODY,
    });

    expect(resp.status).toBe(503);
    const body = await resp.text();
    expect(body).toContain("not enabled on this proxy");
  });

  // -------------------------------------------------------------------------
  // Regression: paused endpoint still returns 503 before the routing logic
  // runs (so it's not confused with the adapter-missing 503).
  // -------------------------------------------------------------------------
  it("paused endpoint returns 503 with json error (different from adapter-missing 503)", async () => {
    mockRegistry.get.mockResolvedValue({
      ...baseEndpoint,
      paused: true,
    });

    const adapters = new Map<string, object>([["solana-devnet", solanaAdapterStub]]);
    const app = makeApp(makeContext({ adapters }));

    const resp = await app.request("/v1/helius/?pact_wallet=wallet-paused", {
      method: "POST",
      body: "{}",
    });

    expect(resp.status).toBe(503);
    // The paused 503 is JSON; the adapter-missing 503 is plain text.
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("endpoint paused");
  });
});
