import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/cmd/run.ts";

describe("e2e devnet (against mock proxy)", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;
  const calls: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-e2e-"));
    const app = new Hono();
    app.get("/.well-known/endpoints", (c) =>
      c.json({
        cacheTtlSec: 3600,
        endpoints: [
          { slug: "helius", hostnames: ["api.helius.xyz"], premiumBps: 100, paused: false },
          { slug: "birdeye", hostnames: ["public-api.birdeye.so"], premiumBps: 200, paused: true },
        ],
      }),
    );
    app.all("/v1/helius/*", (c) => {
      calls.push(c.req.path);
      return c.json({ jsonrpc: "2.0", result: { value: 150_000_000 }, id: 1 });
    });
    app.all("/v1/birdeye/*", (c) => c.text("paused", 423));
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port;
  });

  afterAll(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("flow: pact <helius url> → ok, pact <birdeye url> → endpoint_paused, pact <unknown> → no_provider", async () => {
    const a = await runCommand({
      url: "https://api.helius.xyz/v0/balance/abc",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "e2e",
      cluster: "devnet",
      skipBalanceCheck: true,
    });
    expect(a.status).toBe("ok");

    const b = await runCommand({
      url: "https://public-api.birdeye.so/defi/price",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "e2e",
      cluster: "devnet",
      skipBalanceCheck: true,
    });
    expect(b.status).toBe("endpoint_paused");

    const c = await runCommand({
      url: "https://nope.example.com/foo",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "e2e",
      cluster: "devnet",
      skipBalanceCheck: true,
    });
    expect(c.status).toBe("no_provider");

    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
