import { describe, test, expect, vi } from "vitest";
import { applyDemoBreach } from "../src/lib/force-breach.js";
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

describe("applyDemoBreach", () => {
  test("no-op when demo_breach is false", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const result = await applyDemoBreach({
      demoBreach: false,
      walletPubkey: "wallet1",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(result).toBe(false);
    expect(demoAllowlist.has).not.toHaveBeenCalled();
  });

  test("no-op when walletPubkey is undefined", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const result = await applyDemoBreach({
      demoBreach: true,
      walletPubkey: undefined,
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(result).toBe(false);
  });

  test("no-op when wallet NOT in allowlist", async () => {
    const demoAllowlist = { has: vi.fn().mockResolvedValue(false) };
    const result = await applyDemoBreach({
      demoBreach: true,
      walletPubkey: "stranger",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    expect(result).toBe(false);
  });

  test("sleeps and returns true when demo_breach=1 and wallet in allowlist", async () => {
    vi.useFakeTimers();
    const demoAllowlist = { has: vi.fn().mockResolvedValue(true) };
    const promise = applyDemoBreach({
      demoBreach: true,
      walletPubkey: "allowed-wallet",
      demoAllowlist: demoAllowlist as any,
      endpoint,
    });
    // advance past slaLatencyMs (200) + 300 = 500ms
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result).toBe(true);
    vi.useRealTimers();
  });
});
