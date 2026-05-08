// Verifies the /.well-known/endpoints discovery payload that the Pact CLI
// (packages/cli/src/lib/discovery.ts) consumes to map user-supplied URLs to
// Pact slugs. The shape MUST stay in sync with the CLI's DiscoveryResponse
// interface — change one, change the other.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { wellKnownEndpointsRoute } from "../src/routes/well-known.js";
import type { EndpointRow } from "../src/lib/endpoints.js";

const heliusRow: EndpointRow = {
  slug: "helius",
  flatPremiumLamports: 500n,
  percentBps: 100,
  slaLatencyMs: 1200,
  imputedCostLamports: 50_000n,
  exposureCapPerHourLamports: 1_000_000n,
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  displayName: "Helius RPC",
};

const birdeyeRow: EndpointRow = {
  slug: "birdeye",
  flatPremiumLamports: 700n,
  percentBps: 200,
  slaLatencyMs: 1500,
  imputedCostLamports: 60_000n,
  exposureCapPerHourLamports: 2_000_000n,
  paused: true,
  upstreamBase: "https://public-api.birdeye.so",
  displayName: "Birdeye",
};

// Slug with no entry in the static hostnames map — must be filtered out so
// the CLI never sees an endpoint it cannot route to.
const orphanRow: EndpointRow = {
  ...heliusRow,
  slug: "no-such-provider",
};

let mockRows: EndpointRow[] = [];
const mockRegistry = {
  getAll: vi.fn(async () => mockRows),
  get: vi.fn(),
  get size() {
    return mockRows.length;
  },
};

vi.mock("../src/lib/context.js", () => ({
  getContext: () => ({ registry: mockRegistry }),
  initContext: vi.fn(),
  setContext: vi.fn(),
}));

function buildApp(rows: EndpointRow[]) {
  mockRows = rows;
  const app = new Hono();
  app.get("/.well-known/endpoints", wellKnownEndpointsRoute);
  return app;
}

describe("/.well-known/endpoints", () => {
  beforeEach(() => {
    mockRegistry.getAll.mockClear();
  });

  test("returns DiscoveryResponse shape with cacheTtlSec and endpoints", async () => {
    const app = buildApp([heliusRow, birdeyeRow]);
    const res = await app.request("/.well-known/endpoints");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cacheTtlSec: number;
      endpoints: Array<{
        slug: string;
        hostnames: string[];
        premiumBps: number;
        paused: boolean;
      }>;
    };

    expect(typeof body.cacheTtlSec).toBe("number");
    expect(body.cacheTtlSec).toBeGreaterThan(0);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints.length).toBe(2);
  });

  test("maps each registered slug to its public hostnames", async () => {
    const app = buildApp([heliusRow]);
    const res = await app.request("/.well-known/endpoints");
    const body = (await res.json()) as {
      endpoints: Array<{ slug: string; hostnames: string[] }>;
    };

    const helius = body.endpoints.find((e) => e.slug === "helius");
    expect(helius).toBeDefined();
    expect(helius!.hostnames).toContain("api.helius.xyz");
    expect(helius!.hostnames).toContain("mainnet.helius-rpc.com");
  });

  test("propagates paused flag and percentBps as premiumBps", async () => {
    const app = buildApp([heliusRow, birdeyeRow]);
    const res = await app.request("/.well-known/endpoints");
    const body = (await res.json()) as {
      endpoints: Array<{
        slug: string;
        premiumBps: number;
        paused: boolean;
      }>;
    };

    const helius = body.endpoints.find((e) => e.slug === "helius")!;
    expect(helius.premiumBps).toBe(100);
    expect(helius.paused).toBe(false);

    const birdeye = body.endpoints.find((e) => e.slug === "birdeye")!;
    expect(birdeye.premiumBps).toBe(200);
    expect(birdeye.paused).toBe(true);
  });

  test("filters out slugs with no hostname mapping", async () => {
    const app = buildApp([heliusRow, orphanRow]);
    const res = await app.request("/.well-known/endpoints");
    const body = (await res.json()) as {
      endpoints: Array<{ slug: string }>;
    };

    expect(body.endpoints.map((e) => e.slug)).toEqual(["helius"]);
  });

  test("returns empty endpoints array when registry is empty", async () => {
    const app = buildApp([]);
    const res = await app.request("/.well-known/endpoints");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cacheTtlSec: number;
      endpoints: unknown[];
    };
    expect(body.endpoints).toEqual([]);
    expect(body.cacheTtlSec).toBeGreaterThan(0);
  });
});
