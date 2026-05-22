/**
 * evm-only-boot.spec.ts — multi-evm WP T5 (redo). REAL-config boot acceptance.
 *
 * Wires the REAL @nestjs/config ConfigService (which reads process.env — NOT a
 * mock) into the REAL settler boot-path providers (AdaptersService,
 * SecretLoaderService, SignerBalanceService, SubmitterService) and runs every
 * constructor + onModuleInit in dependency order. Proves an EVM-only settler
 * (PACT_ENABLED_NETWORKS with no solana-*, and NO SOLANA_RPC_URL / NO
 * SETTLEMENT_AUTHORITY_KEY) boots WITHOUT throwing. These are the three
 * providers that hard-required Solana env at boot; the original T5 per-service
 * mock test missed them because it never fed a real config through every
 * provider.
 *
 * Why manual wiring, not Test.createTestingModule: the settler runs under
 * vitest/esbuild, which does not emit `design:paramtypes` decorator metadata, so
 * Nest's injector cannot resolve constructor params in-process (every existing
 * settler test instantiates providers directly for this reason). The full Nest
 * injector is exercised by the nest-built `node dist/main.js` boot. Here we use
 * the REAL ConfigService over process.env so the getOrThrow boot blockers are
 * crossed exactly as in production.
 *
 * Only network egress is substituted: the viem JSON-RPC transport (global fetch,
 * so the EVM signer gas poll never hits Arc) and @google-cloud/secret-manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { register } from "prom-client";
import { generatePrivateKey } from "viem/accounts";

import { AdaptersService } from "../src/adapters/adapters.service.js";
import { SecretLoaderService } from "../src/config/secret-loader.service.js";
import { SignerBalanceService } from "../src/health/signer-balance.service.js";
import { SubmitterService } from "../src/submitter/submitter.service.js";

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
    accessSecretVersion: vi.fn(),
  })),
}));

// Minimal viem JSON-RPC stub so the EVM signer gas poll's getBalance never hits
// a real RPC. Healthy native balance; default 0x for everything else.
async function fakeFetch(
  _input: unknown,
  init?: { body?: unknown },
): Promise<Response> {
  const bodyText = typeof init?.body === "string" ? init.body : "";
  const payload = JSON.parse(bodyText) as
    | { id: number; method: string }
    | Array<{ id: number; method: string }>;
  const answer = (method: string): unknown => {
    if (method === "eth_getBalance") return "0x" + (10n ** 18n).toString(16);
    if (method === "eth_chainId") return "0x4cefd2"; // 5042002
    return "0x";
  };
  const one = (r: { id: number; method: string }) => ({
    jsonrpc: "2.0",
    id: r.id,
    result: answer(r.method),
  });
  const result = Array.isArray(payload) ? payload.map(one) : one(payload);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Boot every settler boot-path provider with one real ConfigService. */
async function bootSettlerProviders(config: ConfigService): Promise<void> {
  const adapters = new AdaptersService(config);
  adapters.onModuleInit();

  const secrets = new SecretLoaderService(config);
  await secrets.onModuleInit();

  const balance = new SignerBalanceService(config, secrets, adapters);
  await balance.onModuleInit();

  const submitter = new SubmitterService(config, secrets, adapters);
  await submitter.onModuleInit();
}

describe("settler EVM-only boot (multi-evm WP T5)", () => {
  let savedSolanaRpc: string | undefined;
  let savedAuthKey: string | undefined;

  beforeEach(() => {
    register.clear();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    // The two Solana boot-blocker env keys MUST be absent for a true EVM-only
    // boot, so getOrThrow would throw if any provider still called it.
    savedSolanaRpc = process.env.SOLANA_RPC_URL;
    savedAuthKey = process.env.SETTLEMENT_AUTHORITY_KEY;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.SETTLEMENT_AUTHORITY_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (savedSolanaRpc !== undefined) process.env.SOLANA_RPC_URL = savedSolanaRpc;
    if (savedAuthKey !== undefined)
      process.env.SETTLEMENT_AUTHORITY_KEY = savedAuthKey;
  });

  it("boots all providers EVM-only with no SOLANA_RPC_URL / SETTLEMENT_AUTHORITY_KEY (real ConfigService)", async () => {
    vi.stubEnv("PACT_ENABLED_NETWORKS", "arc-testnet");
    // Valid EVM config: a real 0x signer for arc; arc deployment addresses come
    // from the baked DEPLOYMENTS map (no PACT_EVM_* override needed).
    vi.stubEnv("PACT_SETTLER_KEYPAIR_ARC_TESTNET", generatePrivateKey());
    vi.stubEnv("INDEXER_URL", "http://indexer.local");
    vi.stubEnv("INDEXER_PUSH_SECRET", "secret");

    // Real ConfigService — reads process.env, NOT a mock.
    const config = new ConfigService();

    await expect(bootSettlerProviders(config)).resolves.toBeUndefined();

    // Sanity: the real config truly lacks the Solana boot keys.
    expect(() => config.getOrThrow("SOLANA_RPC_URL")).toThrow();
    expect(() => config.getOrThrow("SETTLEMENT_AUTHORITY_KEY")).toThrow();
  });

  it("EVM-only health is OK (not 503) even though the Solana balance is unmonitored", async () => {
    vi.stubEnv("PACT_ENABLED_NETWORKS", "arc-testnet");
    vi.stubEnv("PACT_SETTLER_KEYPAIR_ARC_TESTNET", generatePrivateKey());

    const config = new ConfigService();
    const adapters = new AdaptersService(config);
    adapters.onModuleInit();
    const secrets = new SecretLoaderService(config);
    await secrets.onModuleInit();
    const balance = new SignerBalanceService(config, secrets, adapters);
    await balance.onModuleInit();

    const { HealthController } = await import("../src/health/health.controller.js");
    const ctrl = new HealthController(
      { lagMs: 0 } as never,
      balance,
    );
    const res = { statusCode: 200, status(c: number) { this.statusCode = c; return this; } };
    const body = ctrl.check(res as never);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(balance.solanaMonitored).toBe(false);
  });

  it("still fails fast at construction when Solana is enabled but SOLANA_RPC_URL is missing", () => {
    vi.stubEnv("PACT_ENABLED_NETWORKS", "solana-devnet");
    const config = new ConfigService();
    const adapters = new AdaptersService(config);
    adapters.onModuleInit();
    const secrets = new SecretLoaderService(config);

    // SubmitterService (and SignerBalanceService) build the Solana deps in the
    // constructor when a Solana network is enabled -> getOrThrow SOLANA_RPC_URL.
    expect(
      () => new SubmitterService(config, secrets, adapters),
    ).toThrow(/SOLANA_RPC_URL/);
  });
});
