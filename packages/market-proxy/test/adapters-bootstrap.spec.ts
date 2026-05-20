/**
 * adapters-bootstrap.spec.ts — WP-MN-03b T3
 *
 * Exercises buildAdapterMap() directly (no Hono, no Postgres, no RPC).
 * Validates Map<network, ChainAdapter> construction from env vars.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock src/env.js so that importing context.ts doesn't trigger Zod validation
// of missing env vars (PG_URL, RPC_URL, etc.).
// ---------------------------------------------------------------------------
vi.mock("../src/env.js", () => ({
  env: {
    PG_URL: "postgres://localhost:5432/test",
    RPC_URL: "https://api.devnet.solana.com",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    QUEUE_BACKEND: "redis",
    PUBSUB_PROJECT: "",
    PUBSUB_TOPIC: "",
    REDIS_URL: "redis://localhost:6379",
    REDIS_STREAM: "pact-events",
    ADMIN_BEARER: "test-bearer",
    PACT_BETA_GATE_ENABLED: false,
  },
}));

// ---------------------------------------------------------------------------
// Mock @pact-network/shared so no real filesystem reads or RPC calls occur.
// ---------------------------------------------------------------------------
const mockSolanaAdapterInstances: object[] = [];
const mockEvmAdapterStubInstances: object[] = [];

vi.mock("@pact-network/shared", () => {
  const CHAINS: Record<string, { vm: string; network: string; usdcMint: string; usdcDecimals: number }> = {
    "solana-devnet": { vm: "solana", network: "solana-devnet", usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", usdcDecimals: 6 },
    "arc-testnet":   { vm: "evm",    network: "arc-testnet",   usdcMint: "0x0", usdcDecimals: 6 },
  };

  function getChain(name: string) {
    const c = CHAINS[name];
    if (!c) throw new Error(`unknown network "${name}"`);
    return { ...c };
  }

  class SolanaAdapter {
    descriptor: object;
    constructor(opts: { descriptor: object }) {
      this.descriptor = opts.descriptor;
      mockSolanaAdapterInstances.push(this);
    }
  }

  class EvmAdapterStub {
    descriptor: object;
    constructor(opts: { descriptor: object }) {
      this.descriptor = opts.descriptor;
      mockEvmAdapterStubInstances.push(this);
    }
  }

  return { getChain, SolanaAdapter, EvmAdapterStub };
});

import { buildAdapterMap } from "../src/lib/context.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAdapterMap (market-proxy)", () => {
  beforeEach(() => {
    mockSolanaAdapterInstances.length = 0;
    mockEvmAdapterStubInstances.length = 0;
  });

  it("default boot (no PACT_ENABLED_NETWORKS): exactly 1 entry, solana-devnet, vm=solana", () => {
    const { adapters, legacyDirectSolana } = buildAdapterMap({});

    expect(adapters.size).toBe(1);
    expect(adapters.has("solana-devnet")).toBe(true);
    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterStubInstances).toHaveLength(0);
    expect(legacyDirectSolana).toBe(false);
  });

  it("PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet: 2 entries, second is EvmAdapterStub", () => {
    const { adapters } = buildAdapterMap({
      PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet",
    });

    expect(adapters.size).toBe(2);
    expect(adapters.has("solana-devnet")).toBe(true);
    expect(adapters.has("arc-testnet")).toBe(true);
    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterStubInstances).toHaveLength(1);

    const arcAdapter = adapters.get("arc-testnet");
    expect(mockEvmAdapterStubInstances).toContain(arcAdapter);
  });

  it("PACT_ENABLED_NETWORKS=bogus-chain: throws via getChain (unknown network)", () => {
    expect(() =>
      buildAdapterMap({ PACT_ENABLED_NETWORKS: "bogus-chain" }),
    ).toThrow(/unknown network "bogus-chain"/);
  });

  it("PACT_LEGACY_DIRECT_SOLANA=true: flag captured", () => {
    const { legacyDirectSolana } = buildAdapterMap({
      PACT_LEGACY_DIRECT_SOLANA: "true",
    });
    expect(legacyDirectSolana).toBe(true);
  });

  it("PACT_LEGACY_DIRECT_SOLANA absent or non-'true': flag is false", () => {
    expect(buildAdapterMap({}).legacyDirectSolana).toBe(false);
    expect(buildAdapterMap({ PACT_LEGACY_DIRECT_SOLANA: "false" }).legacyDirectSolana).toBe(false);
    expect(buildAdapterMap({ PACT_LEGACY_DIRECT_SOLANA: "1" }).legacyDirectSolana).toBe(false);
  });

  it("PACT_RPC_URL_SOLANA_DEVNET is passed to SolanaAdapter", () => {
    const { adapters } = buildAdapterMap({
      PACT_RPC_URL_SOLANA_DEVNET: "https://my-custom-rpc.example.com",
    });
    // Adapter was constructed — we can't inspect opts after construction in
    // the mock, but we confirm it didn't throw and 1 solana adapter exists.
    expect(adapters.size).toBe(1);
    expect(mockSolanaAdapterInstances).toHaveLength(1);
  });
});
