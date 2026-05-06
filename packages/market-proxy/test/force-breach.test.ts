import { describe, test, expect, vi } from "vitest";
import {
  applyDemoBreach,
  computeDemoBreachDelayMs,
} from "../src/lib/force-breach.js";
import type { EndpointRow } from "../src/lib/endpoints.js";

const endpoint: EndpointRow = {
  slug: "helius",
  flatPremiumLamports: 500n,
  percentBps: 10,
  slaLatencyMs: 200,
  imputedCostLamports: 50000n,
  exposureCapPerHourLamports: 1000000n,
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  displayName: "Helius RPC",
};

describe("computeDemoBreachDelayMs", () => {
  test("returns 0 when demo_breach is false", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const ms = await computeDemoBreachDelayMs({
      demoBreach: false,
      walletPubkey: "wallet1",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(ms).toBe(0);
    expect(demoAllowlist.has).not.toHaveBeenCalled();
  });

  test("returns 0 when walletPubkey is undefined", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const ms = await computeDemoBreachDelayMs({
      demoBreach: true,
      walletPubkey: undefined,
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(ms).toBe(0);
  });

  test("returns 0 when wallet NOT in allowlist", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(false) };
    const ms = await computeDemoBreachDelayMs({
      demoBreach: true,
      walletPubkey: "stranger",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(ms).toBe(0);
  });

  test("returns slaLatencyMs+300 when allowed", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const ms = await computeDemoBreachDelayMs({
      demoBreach: true,
      walletPubkey: "allowed-wallet",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(ms).toBe(500); // sla 200 + 300
  });
});

describe("applyDemoBreach (legacy)", () => {
  test("no-op when demo_breach is false", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const result = await applyDemoBreach({
      demoBreach: false,
      walletPubkey: "wallet1",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(result).toBe(false);
  });

  test("sleeps and returns true when demo_breach=1 and wallet allowlisted", async () => {
    vi.useFakeTimers();
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const promise = applyDemoBreach({
      demoBreach: true,
      walletPubkey: "allowed-wallet",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result).toBe(true);
    vi.useRealTimers();
  });
});
