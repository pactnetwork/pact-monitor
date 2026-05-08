import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
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
    port = server.port!;
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
      skipBalanceCheck: true,
      raw: true,
    });
    expect(env.status).not.toBe("no_provider");
  });

  // Fix 1: pre-flight balance check returns needs_funding when balance is 0
  test("balance check returns needs_funding when balance is insufficient", async () => {
    const env = await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      skipBalanceCheck: false,
      getBalanceLamports: async (_pubkey: PublicKey) => 0n,
    });
    expect(env.status).toBe("needs_funding");
    const body = env.body as { wallet: string; needed_usdc: number; current_balance_usdc: number; deposit_url: string };
    expect(body.current_balance_usdc).toBe(0);
    expect(body.needed_usdc).toBeGreaterThan(0);
    expect(body.deposit_url).toContain("dashboard.pactnetwork.io/agents/");
    expect(body.wallet).toBeDefined();
  });

  test("balance check passes when balance is sufficient", async () => {
    const env = await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      skipBalanceCheck: false,
      getBalanceLamports: async (_pubkey: PublicKey) => 1_000_000n,
    });
    expect(env.status).toBe("ok");
  });
});

// Fix 6: signature_rejected handling
describe("cmd/run: signature_rejected", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-sigrej-test-"));
    const app = new Hono();
    app.get("/.well-known/endpoints", (c) => c.json(ENDPOINTS));
    app.all("/v1/helius/*", (c) =>
      c.text("signature_rejected", 401, { "x-pact-error": "signature_rejected" }),
    );
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns signature_rejected envelope when proxy returns 401 with x-pact-error header", async () => {
    const env = await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      skipBalanceCheck: true,
    });
    expect(env.status).toBe("signature_rejected");
    const body = env.body as { hint: string };
    expect(body.hint).toContain("clock skew");
  });
});
