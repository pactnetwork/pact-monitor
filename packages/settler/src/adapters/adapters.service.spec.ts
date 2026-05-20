import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Mock @pact-network/shared so we can control getChain, SolanaAdapter,
// EvmAdapterStub without any real RPC calls or filesystem reads.
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

// ---------------------------------------------------------------------------
// Also mock @solana/web3.js Keypair so fromSecretKey works in loadKeypair test
// without real crypto. We keep the real Keypair for keypair generation.
// ---------------------------------------------------------------------------
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return { ...actual };
});

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { AdaptersService } from "./adapters.service";

// ---------------------------------------------------------------------------
// Helper: build a ConfigService mock from a plain env map
// ---------------------------------------------------------------------------
function makeConfig(env: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn().mockImplementation((k: string) => env[k] ?? undefined),
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (!env[k]) throw new Error(`missing ${k}`);
      return env[k];
    }),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdaptersService (settler)", () => {
  beforeEach(() => {
    mockSolanaAdapterInstances.length = 0;
    mockEvmAdapterStubInstances.length = 0;
  });

  it("default boot (no PACT_ENABLED_NETWORKS): exactly 1 entry, solana-devnet, vm=solana", () => {
    const svc = new AdaptersService(makeConfig());
    svc.onModuleInit();

    expect(svc.listEnabledNetworks()).toEqual(["solana-devnet"]);
    const adapter = svc.getAdapter("solana-devnet");
    expect(adapter).toBeDefined();
    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterStubInstances).toHaveLength(0);
  });

  it("PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet: 2 entries, second is EvmAdapterStub", () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    svc.onModuleInit();

    const networks = svc.listEnabledNetworks();
    expect(networks).toHaveLength(2);
    expect(networks).toContain("solana-devnet");
    expect(networks).toContain("arc-testnet");

    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterStubInstances).toHaveLength(1);

    // arc-testnet adapter is the EvmAdapterStub instance
    const arcAdapter = svc.getAdapter("arc-testnet");
    expect(mockEvmAdapterStubInstances).toContain(arcAdapter);
  });

  it("PACT_ENABLED_NETWORKS=bogus-chain: throws via getChain (unknown network)", () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "bogus-chain" }),
    );
    expect(() => svc.onModuleInit()).toThrow(/unknown network "bogus-chain"/);
  });

  it("PACT_LEGACY_DIRECT_SOLANA=true: flag captured", () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_LEGACY_DIRECT_SOLANA: "true" }),
    );
    expect(svc.legacyDirectSolana).toBe(true);
  });

  it("PACT_LEGACY_DIRECT_SOLANA absent or other value: flag is false", () => {
    expect(new AdaptersService(makeConfig()).legacyDirectSolana).toBe(false);
    expect(
      new AdaptersService(makeConfig({ PACT_LEGACY_DIRECT_SOLANA: "false" }))
        .legacyDirectSolana,
    ).toBe(false);
    expect(
      new AdaptersService(makeConfig({ PACT_LEGACY_DIRECT_SOLANA: "1" }))
        .legacyDirectSolana,
    ).toBe(false);
  });

  it("loadKeypair: parses a valid keypair JSON env var (PACT_SETTLER_KEYPAIR for solana-devnet)", () => {
    const kp = Keypair.generate();
    const raw = JSON.stringify(Array.from(kp.secretKey));

    const svc = new AdaptersService(
      makeConfig({ PACT_SETTLER_KEYPAIR: raw }),
    );
    svc.onModuleInit();

    const loaded = svc.getSigner("solana-devnet");
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("loadKeypair: PACT_SETTLER_KEYPAIR_SOLANA_DEVNET takes precedence over fallback", () => {
    const kp1 = Keypair.generate();
    const kp2 = Keypair.generate();

    const svc = new AdaptersService(
      makeConfig({
        PACT_SETTLER_KEYPAIR: JSON.stringify(Array.from(kp1.secretKey)),
        PACT_SETTLER_KEYPAIR_SOLANA_DEVNET: JSON.stringify(Array.from(kp2.secretKey)),
      }),
    );
    svc.onModuleInit();

    const loaded = svc.getSigner("solana-devnet");
    expect(loaded.publicKey.toBase58()).toBe(kp2.publicKey.toBase58());
  });

  it("getSigner throws for a network with no loaded keypair", () => {
    // arc-testnet has no keypair loading (EVM signer is WP-MN-04)
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    svc.onModuleInit();
    expect(() => svc.getSigner("arc-testnet")).toThrow(/No settler signer loaded/);
  });

  it("getAdapter throws for a network not in the map", () => {
    const svc = new AdaptersService(makeConfig());
    svc.onModuleInit();
    expect(() => svc.getAdapter("solana-mainnet")).toThrow(/No adapter for network/);
  });
});
