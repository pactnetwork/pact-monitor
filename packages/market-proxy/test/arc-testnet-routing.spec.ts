/**
 * arc-testnet-routing.spec.ts — WP-MN-04 T5
 *
 * Adds the SUCCESS-path arc-testnet routing assertion that WP-MN-03b's
 * multi-network-routing.spec.ts could not write at the time (its EvmAdapter
 * was a not-implemented stub).
 *
 * What this proves: when an endpoint is registered with `network: 'arc-testnet'`
 * and the proxy has an arc-testnet EvmAdapter in its map that resolves
 * `checkAgentEligibility` successfully (mimicking the real EvmAdapter after
 * WP-MN-04 T2 ships), the proxy:
 *   1. Routes to the arc-testnet adapter (not the Solana one).
 *   2. The eligibility check returns 200 → the upstream call proceeds.
 *   3. The 503 'balance_check_failed' path from WP-MN-03b is NOT taken.
 *
 * The WP-MN-03b file already covers the failure modes (stub throws, unknown
 * network, paused endpoint, etc.) — this file only adds the green-path lock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { MemoryEventSink, type BalanceCheck } from "@pact-network/wrap";

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

const mockRegistry = { get: vi.fn() };
const mockDemoAllowlist = { has: vi.fn().mockResolvedValue(false) };
const memorySink = new MemoryEventSink();

const legacyBalanceCheck: BalanceCheck = {
  check: vi.fn().mockResolvedValue({
    eligible: true,
    ataBalance: 100_000_000n,
    allowance: 100_000_000n,
  }),
};

const evmAdapterSuccess = {
  // Mimic the real EvmAdapter (T2-shipped) return shape on the eligible path.
  checkAgentEligibility: vi.fn().mockResolvedValue({
    eligible: true,
    balance: 500_000_000n,
    allowance: 500_000_000n,
  }),
  submitSettleBatch: vi.fn(),
};

const solanaAdapterStub = {
  checkAgentEligibility: vi.fn().mockResolvedValue({
    eligible: true,
    balance: 100_000_000n,
    allowance: 100_000_000n,
  }),
  submitSettleBatch: vi.fn(),
};

const mockUpstreamFetch = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ ok: true, network: "arc-testnet" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
);
vi.stubGlobal("fetch", mockUpstreamFetch);

const baseEndpoint = {
  slug: "helius",
  network: "arc-testnet",
  flatPremiumLamports: 500n,
  percentBps: 0,
  slaLatencyMs: 1200,
  imputedCostLamports: 50000n,
  exposureCapPerHourLamports: 1_000_000n,
  paused: false,
  upstreamBase: "https://upstream.example.com",
  displayName: "Helius Arc",
};

import { proxyRoute } from "../src/routes/proxy.js";
import { setContext } from "../src/lib/context.js";

function makeApp(ctx: object): Hono {
  setContext(ctx as never);
  const app = new Hono();
  app.all("/v1/:slug/*", proxyRoute);
  app.all("/v1/:slug", proxyRoute);
  return app;
}

function makeContext(overrides: {
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
    adapters:
      overrides.adapters ??
      new Map([
        ["solana-devnet", solanaAdapterStub],
        ["arc-testnet", evmAdapterSuccess],
      ]),
    legacyDirectSolana: overrides.legacyDirectSolana ?? false,
  };
}

const HELIUS_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "getAccountInfo",
  params: [],
});

describe("WP-MN-04 T5 — arc-testnet routing success path", () => {
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
    evmAdapterSuccess.checkAgentEligibility.mockReset().mockResolvedValue({
      eligible: true,
      balance: 500_000_000n,
      allowance: 500_000_000n,
    });
    mockUpstreamFetch.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, network: "arc-testnet" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    memorySink.reset();
    process.env.PACT_PROXY_INSECURE_DEMO = "1";
  });

  it("arc-testnet endpoint with real-shaped EvmAdapter success returns 200; upstream reached; SolanaAdapter untouched", async () => {
    mockRegistry.get.mockResolvedValue({
      ...baseEndpoint,
      network: "arc-testnet",
    });

    const adapters = new Map<string, object>([
      ["solana-devnet", solanaAdapterStub],
      ["arc-testnet", evmAdapterSuccess],
    ]);
    const app = makeApp(makeContext({ adapters, legacyDirectSolana: false }));

    const resp = await app.request("/v1/helius/?pact_wallet=walletArcOk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: HELIUS_BODY,
    });

    // 1. EvmAdapter was reached and consulted with the wallet pubkey.
    //    (Required-premium arg shape is exercised by the WP-MN-02 SolanaAdapter
    //    parity test + the WP-MN-04 T2 EvmAdapter unit test; here we just lock
    //    routing dispatch, not the wrap → balanceCheck → adapter arg-shape.)
    expect(evmAdapterSuccess.checkAgentEligibility).toHaveBeenCalled();
    const [walletArg] =
      evmAdapterSuccess.checkAgentEligibility.mock.calls[0];
    expect(walletArg).toBe("walletArcOk");

    // 2. Solana adapter was NOT called — routing dispatched only to arc-testnet.
    expect(solanaAdapterStub.checkAgentEligibility).not.toHaveBeenCalled();

    // 3. Legacy balance-check bypassed — adapter path was used.
    expect(legacyBalanceCheck.check).not.toHaveBeenCalled();

    // 4. Upstream reached — proxy passed through after eligibility OK.
    expect(mockUpstreamFetch).toHaveBeenCalledOnce();

    // 5. Final response is 200 (NOT 503 balance_check_failed from WP-MN-03b).
    expect(resp.status).toBe(200);
  });
});
