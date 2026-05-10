import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchEndpoints,
  resolveSlug,
  invalidateCache,
  cachePath,
} from "../src/lib/discovery.ts";

const SAMPLE = {
  cacheTtlSec: 3600,
  endpoints: [
    {
      slug: "helius",
      hostnames: ["api.helius.xyz", "mainnet.helius-rpc.com"],
      premiumBps: 100,
      paused: false,
    },
    {
      slug: "birdeye",
      hostnames: ["public-api.birdeye.so"],
      premiumBps: 200,
      paused: true,
    },
  ],
};

describe("discovery", () => {
  let dir: string;
  let port: number;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-disc-test-"));
    const app = new Hono();
    app.get("/.well-known/endpoints", (c) => c.json(SAMPLE));
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("fetchEndpoints fetches and writes cache", async () => {
    const res = await fetchEndpoints({
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
    });
    expect(res.endpoints.length).toBe(2);
    expect(res.fetchedAt).toBeGreaterThan(0);
  });

  test("fetchEndpoints uses cache when fresh", async () => {
    await fetchEndpoints({
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
    });
    server.stop();
    const res = await fetchEndpoints({
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
    });
    expect(res.endpoints.length).toBe(2);
  });

  test("fetchEndpoints refetches when cache expired", async () => {
    await fetchEndpoints({
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
    });
    const path = cachePath(dir);
    const stale = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
    stale.fetchedAt = Date.now() - 7200_000;
    writeFileSync(path, JSON.stringify(stale));
    const res = await fetchEndpoints({
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
    });
    expect(res.fetchedAt).toBeGreaterThan(stale.fetchedAt);
  });

  test("resolveSlug matches hostname to slug", () => {
    const r = resolveSlug({
      url: "https://api.helius.xyz/v0/addresses/abc/balances",
      endpoints: SAMPLE.endpoints,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slug).toBe("helius");
      expect(r.upstreamPath).toBe("/v0/addresses/abc/balances");
    }
  });

  test("resolveSlug returns endpoint_paused when paused", () => {
    const r = resolveSlug({
      url: "https://public-api.birdeye.so/defi/v3",
      endpoints: SAMPLE.endpoints,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("endpoint_paused");
  });

  test("resolveSlug returns no_provider for unknown hostname", () => {
    const r = resolveSlug({
      url: "https://unknown.example.com/foo",
      endpoints: SAMPLE.endpoints,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_provider");
  });

  test("invalidateCache removes cache file", async () => {
    await fetchEndpoints({
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
    });
    invalidateCache(dir);
    expect(require("node:fs").existsSync(cachePath(dir))).toBe(false);
  });
});
