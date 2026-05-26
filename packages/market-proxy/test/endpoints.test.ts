import { describe, test, expect, vi, beforeEach } from "vitest";
import { EndpointRegistry } from "../src/lib/endpoints.js";

const mockRow = {
  slug: "helius",
  network: "solana-devnet",
  flatPremiumLamports: "500",
  percentBps: 10,
  slaLatencyMs: 1200,
  imputedCostLamports: "50000",
  exposureCapPerHourLamports: "1000000",
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  displayName: "Helius RPC",
};

describe("EndpointRegistry", () => {
  test("loads endpoints from Postgres on first call, caches 60s", async () => {
    const mockPg = { query: vi.fn().mockResolvedValue({ rows: [mockRow] }) };
    const reg = new EndpointRegistry(mockPg as any);

    const e1 = await reg.get("helius");
    expect(e1?.slug).toBe("helius");
    expect(e1?.flatPremiumLamports).toBe(500n);
    expect(e1?.slaLatencyMs).toBe(1200);
    expect(mockPg.query).toHaveBeenCalledTimes(1);

    await reg.get("helius"); // cache hit
    expect(mockPg.query).toHaveBeenCalledTimes(1);
  });

  test("returns undefined for unknown slug", async () => {
    const mockPg = { query: vi.fn().mockResolvedValue({ rows: [mockRow] }) };
    const reg = new EndpointRegistry(mockPg as any);
    const e = await reg.get("unknown");
    expect(e).toBeUndefined();
  });

  test("reload() forces refresh", async () => {
    const mockPg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const reg = new EndpointRegistry(mockPg as any);
    await reg.get("helius");
    await reg.reload();
    await reg.get("helius");
    expect(mockPg.query).toHaveBeenCalledTimes(2);
  });

  test("size reflects loaded endpoint count", async () => {
    const mockPg = { query: vi.fn().mockResolvedValue({ rows: [mockRow] }) };
    const reg = new EndpointRegistry(mockPg as any);
    await reg.reload();
    expect(reg.size).toBe(1);
  });
});
