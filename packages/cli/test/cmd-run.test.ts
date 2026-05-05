import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/cmd/run.ts";

const ENDPOINTS = {
  cacheTtlSec: 3600,
  endpoints: [
    {
      slug: "helius",
      hostnames: ["api.helius.xyz"],
      premiumBps: 100,
      paused: false,
    },
  ],
};

describe("cmd/run", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-runcmd-test-"));
    const app = new Hono();
    app.get("/.well-known/endpoints", (c) => c.json(ENDPOINTS));
    app.all("/v1/helius/*", (c) => c.json({ ok: true, path: c.req.path }));
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port;
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("happy path returns ok envelope", async () => {
    const env = await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      cluster: "devnet",
      skipBalanceCheck: true,
    });
    expect(env.status).toBe("ok");
    expect(env.meta?.slug).toBe("helius");
    expect(env.meta?.tx_signature).toBeNull();
  });

  test("unknown hostname returns no_provider envelope", async () => {
    const env = await runCommand({
      url: "https://unknown.example/foo",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      cluster: "devnet",
      skipBalanceCheck: true,
    });
    expect(env.status).toBe("no_provider");
  });

  test("--raw skips slug resolution", async () => {
    const env = await runCommand({
      url: "https://unknown.example/foo",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      cluster: "devnet",
      skipBalanceCheck: true,
      raw: true,
    });
    expect(env.status).not.toBe("no_provider");
  });
});
