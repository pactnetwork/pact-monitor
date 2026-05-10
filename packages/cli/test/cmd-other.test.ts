import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsShowCommand, agentsWatchCommand } from "../src/cmd/agents.ts";

describe("cmd/agents", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-agentsshow-test-"));
    const app = new Hono();
    app.get("/v1/agents/:pubkey", (c) =>
      c.json({
        pubkey: c.req.param("pubkey"),
        balance_usdc: 12.3,
        recent_calls: [],
      }),
    );
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("agents show fetches and returns ok envelope", async () => {
    const env = await agentsShowCommand({
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      pubkey: "TestPubKey1111111111111111111111111111111111",
    });
    expect(env.status).toBe("ok");
    const body = env.body as { balance_usdc: number };
    expect(body.balance_usdc).toBe(12.3);
  });
});

// Fix 4: agentsWatchCommand should throw on non-ok HTTP status
describe("cmd/agents: watch HTTP error", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-agentswatch-test-"));
    const app = new Hono();
    app.get("/v1/agents/:pubkey/events", (c) =>
      c.text("Unauthorized", 401),
    );
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("agentsWatchCommand throws with HTTP status when server returns 401", async () => {
    await expect(
      agentsWatchCommand({
        configDir: dir,
        gatewayUrl: `http://localhost:${port}`,
        pubkey: "TestPubKey1111111111111111111111111111111111",
        onEvent: () => {},
      }),
    ).rejects.toThrow("watch: HTTP 401");
  });
});
