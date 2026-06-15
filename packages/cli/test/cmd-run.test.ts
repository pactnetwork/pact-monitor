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
    // Pre-existing smoke check: with the gate open and a reachable gateway,
    // --raw against an unknown hostname returns a non-no_provider envelope.
    const originalGate = process.env.PACT_MAINNET_ENABLED;
    process.env.PACT_MAINNET_ENABLED = "1";
    try {
      const env = await runCommand({
        url: "https://unknown.example/foo",
        method: "GET",
        headers: {},
        configDir: dir,
        gatewayUrl: `http://localhost:${port}`,
        project: "test",
        skipBalanceCheck: true,
        raw: true,
        timeoutMs: 1000,
      });
      expect(env.status).not.toBe("no_provider");
      // The raw path never resolves a provider slug; meta.slug must be "raw".
      expect(env.meta?.slug).toBe("raw");
    } finally {
      if (originalGate === undefined) delete process.env.PACT_MAINNET_ENABLED;
      else process.env.PACT_MAINNET_ENABLED = originalGate;
    }
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

// Codex review on PR #64 (2026-05-10T16:28:08Z): --raw was documented as an
// uninsured direct call but runCommand still fetched /.well-known/endpoints
// and routed through the gateway as slug=raw. These tests pin the new
// contract: --raw is a true direct upstream call.
describe("cmd/run: --raw direct upstream call", () => {
  let dir: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let upstreamPort: number;
  let recordedHost: string | null = null;
  let recordedPath: string | null = null;
  let recordedHeaders: Record<string, string> = {};
  let upstreamHits = 0;
  const originalGate = process.env.PACT_MAINNET_ENABLED;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-raw-direct-test-"));
    recordedHost = null;
    recordedPath = null;
    recordedHeaders = {};
    upstreamHits = 0;
    process.env.PACT_MAINNET_ENABLED = "1";
    const upstreamApp = new Hono();
    upstreamApp.all("*", (c) => {
      upstreamHits++;
      recordedHost = c.req.header("host") ?? null;
      recordedPath = c.req.path + (new URL(c.req.url).search ?? "");
      recordedHeaders = Object.fromEntries(
        Array.from(new Headers(c.req.raw.headers).entries()),
      );
      return c.json({ ok: true, hit: upstreamHits });
    });
    upstream = Bun.serve({ port: 0, fetch: upstreamApp.fetch });
    upstreamPort = upstream.port!;
  });

  afterEach(() => {
    upstream.stop();
    rmSync(dir, { recursive: true, force: true });
    if (originalGate === undefined) delete process.env.PACT_MAINNET_ENABLED;
    else process.env.PACT_MAINNET_ENABLED = originalGate;
  });

  test("--raw does not call discovery (gateway unreachable still returns ok)", async () => {
    // Codex repro: a closed gateway port previously caused discovery_unreachable.
    // After the fix, --raw must not attempt /.well-known/endpoints at all.
    const env = await runCommand({
      url: `http://127.0.0.1:${upstreamPort}/probe`,
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: "http://127.0.0.1:1", // closed port — would fail discovery
      project: "raw-test",
      skipBalanceCheck: true,
      raw: true,
      timeoutMs: 2000,
    });
    expect(env.status).toBe("ok");
    expect(env.status).not.toBe("discovery_unreachable");
    expect(upstreamHits).toBe(1);
  });

  test("--raw preserves the original upstream host and path", async () => {
    const env = await runCommand({
      url: `http://127.0.0.1:${upstreamPort}/some/path?q=1`,
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: "http://127.0.0.1:1",
      project: "raw-test",
      skipBalanceCheck: true,
      raw: true,
      timeoutMs: 2000,
    });
    expect(env.status).toBe("ok");
    // Upstream Hono server saw the original host header (127.0.0.1:<port>),
    // not the gateway's host, and the original path/search, not /v1/raw/<...>.
    expect(recordedHost).toBe(`127.0.0.1:${upstreamPort}`);
    expect(recordedPath).toBe("/some/path?q=1");
  });

  test("--raw does not send any x-pact-* signing headers", async () => {
    await runCommand({
      url: `http://127.0.0.1:${upstreamPort}/check-headers`,
      method: "GET",
      headers: { "x-user-header": "preserved" },
      configDir: dir,
      gatewayUrl: "http://127.0.0.1:1",
      project: "raw-test",
      skipBalanceCheck: true,
      raw: true,
      timeoutMs: 2000,
    });
    const pactHeaders = Object.keys(recordedHeaders).filter((k) =>
      k.toLowerCase().startsWith("x-pact-"),
    );
    expect(pactHeaders).toEqual([]);
    // User-supplied header still gets through.
    expect(recordedHeaders["x-user-header"]).toBe("preserved");
  });

  test("--raw envelope has call_id_source=local_fallback and slug=raw", async () => {
    const env = await runCommand({
      url: `http://127.0.0.1:${upstreamPort}/whatever`,
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: "http://127.0.0.1:1",
      project: "raw-test",
      skipBalanceCheck: true,
      raw: true,
      timeoutMs: 2000,
    });
    expect(env.meta?.slug).toBe("raw");
    expect(env.meta?.call_id_source).toBe("local_fallback");
    expect(typeof env.meta?.call_id).toBe("string");
    expect(env.meta?.tx_signature).toBeNull();
    expect(env.meta?.raw).toBe(true);
  });

  test("--raw mainnet gate fires when PACT_MAINNET_ENABLED is unset", async () => {
    // Defense-in-depth: even though --cluster's commander coercer normally
    // catches a closed gate at parse time, the default value bypasses
    // coercion. runCommand must independently re-check the gate on the
    // --raw path.
    delete process.env.PACT_MAINNET_ENABLED;
    const env = await runCommand({
      url: `http://127.0.0.1:${upstreamPort}/never-reached`,
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: "http://127.0.0.1:1",
      project: "raw-test",
      skipBalanceCheck: true,
      raw: true,
      timeoutMs: 2000,
    });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error).toContain("PACT_MAINNET_ENABLED");
    // Crucially, no upstream request should have been made.
    expect(upstreamHits).toBe(0);
  });
});

// EVM wallet-init parity with Solana lazy-gen (project_cli_evm_wallet_init):
// the first `pact <slug> --network <evm-chain>` call with no wallet on disk
// must generate + persist a shared EVM key, print a funding hint, and exit
// without touching the gateway. Re-runs fall through to the normal call path.
import { existsSync as _existsSync } from "node:fs";
import { sharedEvmWalletPath } from "../src/lib/evm-wallet.ts";

describe("cmd/run: EVM wallet halt-on-first-gen", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;
  let gatewayHits = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-evm-init-test-"));
    gatewayHits = 0;
    const app = new Hono();
    app.get("/.well-known/endpoints", (c) => {
      gatewayHits++;
      return c.json(ENDPOINTS);
    });
    app.all("/v1/helius/*", (c) => {
      gatewayHits++;
      return c.json({ ok: true });
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
    delete process.env.PACT_EVM_PRIVATE_KEY;
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("first --network arc-testnet call generates wallet, halts before gateway", async () => {
    const lines: string[] = [];
    const env = await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      network: "arc-testnet",
      skipBalanceCheck: true,
      printEvmInitHint: (m) => lines.push(m),
    });
    expect(env.status).toBe("ok");
    const body = env.body as {
      evm_wallet_created: boolean;
      address: string;
      network: string;
    };
    expect(body.evm_wallet_created).toBe(true);
    expect(body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.network).toBe("arc-testnet");
    // No gateway round-trip happened — we halted before discovery/signing.
    expect(gatewayHits).toBe(0);
    // The funding hint must mention the address + faucet URL.
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(body.address);
    expect(lines[0]).toContain("faucet.circle.com");
    // The shared wallet file was persisted under the per-project configDir.
    expect(_existsSync(sharedEvmWalletPath(dir))).toBe(true);
  });

  test("second --network call with wallet present falls through to gateway", async () => {
    await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      network: "arc-testnet",
      skipBalanceCheck: true,
      printEvmInitHint: () => {},
    });
    const beforeHits = gatewayHits;
    const env = await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      network: "arc-testnet",
      skipBalanceCheck: true,
      printEvmInitHint: () => {
        throw new Error("hint should not print on re-run");
      },
    });
    expect(env.status).toBe("ok");
    expect((env.body as { evm_wallet_created?: boolean }).evm_wallet_created).toBeUndefined();
    expect(gatewayHits).toBeGreaterThan(beforeHits);
  });

  test("--network <solana-cluster> is unaffected — Solana path still runs", async () => {
    const env = await runCommand({
      url: "https://api.helius.xyz/v0/balances",
      method: "GET",
      headers: {},
      configDir: dir,
      gatewayUrl: `http://localhost:${port}`,
      project: "test",
      network: "devnet",
      skipBalanceCheck: true,
    });
    expect(env.status).toBe("ok");
    expect((env.body as { evm_wallet_created?: boolean }).evm_wallet_created).toBeUndefined();
    expect(_existsSync(sharedEvmWalletPath(dir))).toBe(false);
  });
});
