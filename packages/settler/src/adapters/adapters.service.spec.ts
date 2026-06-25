import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { Keypair } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Mock @pact-network/shared so we can control getChain, SolanaAdapter,
// EvmAdapter without any real RPC calls or filesystem reads.
// ---------------------------------------------------------------------------

const mockSolanaAdapterInstances: object[] = [];
const mockEvmAdapterInstances: object[] = [];

vi.mock("@pact-network/shared", () => {
  const CHAINS: Record<string, { vm: string; network: string; usdcMint: string; usdcDecimals: number; chainId: number; rpcUrl: string; finalityBlocks: number; blockTimeMs: number; deploymentBlock: number }> = {
    "solana-devnet": { vm: "solana", network: "solana-devnet", usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", usdcDecimals: 6, chainId: 0, rpcUrl: "", finalityBlocks: 0, blockTimeMs: 0, deploymentBlock: 0 },
    "arc-testnet":   { vm: "evm",    network: "arc-testnet",   usdcMint: "0x0", usdcDecimals: 6, chainId: 5042002, rpcUrl: "https://rpc.testnet.arc.network", finalityBlocks: 64, blockTimeMs: 500, deploymentBlock: 42953139 },
    "base-sepolia":  { vm: "evm",    network: "base-sepolia",  usdcMint: "0x0", usdcDecimals: 6, chainId: 84532,   rpcUrl: "https://sepolia.base.org",      finalityBlocks: 1,  blockTimeMs: 2000, deploymentBlock: 41969204 },
  };

  function getChain(name: string) {
    const c = CHAINS[name];
    if (!c) throw new Error(`unknown network "${name}"`);
    return { ...c };
  }

  function listChains() {
    return Object.values(CHAINS).map((c) => ({ ...c }));
  }

  class SolanaAdapter {
    descriptor: object;
    constructor(opts: { descriptor: object }) {
      this.descriptor = opts.descriptor;
      mockSolanaAdapterInstances.push(this);
    }
  }

  class EvmAdapter {
    descriptor: object;
    rpcUrl?: string;
    constructor(opts: { descriptor: object; rpcUrl?: string }) {
      this.descriptor = opts.descriptor;
      this.rpcUrl = opts.rpcUrl;
      mockEvmAdapterInstances.push(this);
    }
  }

  return { getChain, listChains, SolanaAdapter, EvmAdapter };
});

// ---------------------------------------------------------------------------
// Mock @pact-network/protocol-evm-v1-client so resolveDeployment is a no-op
// in unit tests (no live chain data needed).
// ---------------------------------------------------------------------------
vi.mock("@pact-network/protocol-evm-v1-client", () => ({
  resolveDeployment: vi.fn().mockReturnValue({
    chainId: 5042002,
    usdc: "0x3600000000000000000000000000000000000000",
    registry: "0x056BAC33546b5b51B8CF6f332379651f715B889C",
    pool: "0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE",
    settler: "0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f",
  }),
}));

// ---------------------------------------------------------------------------
// Mock viem/accounts so privateKeyToAccount works without real crypto validation
// ---------------------------------------------------------------------------
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn().mockImplementation((key: string) => ({
    address: "0xdeadbeef",
    _key: key,
    type: "local" as const,
    sign: vi.fn(),
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
    signTypedData: vi.fn(),
    source: "privateKey" as const,
    publicKey: "0xpub",
  })),
}));

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
    mockEvmAdapterInstances.length = 0;
  });

  it("default boot (no PACT_ENABLED_NETWORKS): exactly 1 entry, solana-devnet, vm=solana", () => {
    const svc = new AdaptersService(makeConfig());
    svc.onModuleInit();

    expect(svc.listEnabledNetworks()).toEqual(["solana-devnet"]);
    const adapter = svc.getAdapter("solana-devnet");
    expect(adapter).toBeDefined();
    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterInstances).toHaveLength(0);
  });

  it("PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet: 2 entries, second is EvmAdapter", () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    svc.onModuleInit();

    const networks = svc.listEnabledNetworks();
    expect(networks).toHaveLength(2);
    expect(networks).toContain("solana-devnet");
    expect(networks).toContain("arc-testnet");

    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterInstances).toHaveLength(1);

    // arc-testnet adapter is the real EvmAdapter instance
    const arcAdapter = svc.getAdapter("arc-testnet");
    expect(mockEvmAdapterInstances).toContain(arcAdapter);
  });

  it("EVM RPC override: PACT_RPC_URL_<CHAIN> beats the chain registry rpcUrl", () => {
    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "arc-testnet",
        PACT_RPC_URL_ARC_TESTNET: "https://paid.example/arc",
      }),
    );
    svc.onModuleInit();

    const arc = svc.getAdapter("arc-testnet") as unknown as { rpcUrl: string };
    expect(arc.rpcUrl).toBe("https://paid.example/arc");
  });

  it("EVM RPC default: no override falls back to the chain registry rpcUrl", () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "arc-testnet" }),
    );
    svc.onModuleInit();

    const arc = svc.getAdapter("arc-testnet") as unknown as { rpcUrl: string };
    expect(arc.rpcUrl).toBe("https://rpc.testnet.arc.network");
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

  it("getSigner throws for a network with no loaded keypair (EVM uses getEvmAccount, not getSigner)", () => {
    // arc-testnet uses getEvmAccount() for EVM signers; getSigner() is Solana-only.
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    svc.onModuleInit();
    expect(() => svc.getSigner("arc-testnet")).toThrow(/No settler signer loaded/);
  });

  it("loadEvmAccount: parses a valid 0x-hex private key for arc-testnet (Phase 1)", () => {
    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet",
        PACT_SETTLER_KEYPAIR_ARC_TESTNET: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    );
    svc.onModuleInit();

    // getEvmAccount does not throw when the key was loaded
    const account = svc.getEvmAccount("arc-testnet");
    expect(account).toBeDefined();
    expect(account.address).toBe("0xdeadbeef"); // from the mock
  });

  it("getEvmAccount throws when no EVM key is set", () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    svc.onModuleInit();
    expect(() => svc.getEvmAccount("arc-testnet")).toThrow(/No EVM signer loaded/);
  });

  it("loadEvmAccount: warns and returns null for Secret Manager path (Phase 2 not yet supported)", () => {
    // Setup: env value is a Secret Manager resource path (projects/.../versions/latest).
    // Expected: no signer loaded; warn log fired; getEvmAccount throws.
    const config = makeConfig({
      PACT_ENABLED_NETWORKS: "arc-testnet",
      PACT_SETTLER_KEYPAIR_ARC_TESTNET:
        "projects/test-gcp/secrets/pact-settler-arc-testnet/versions/latest",
    });
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const svc = new AdaptersService(config);
    svc.onModuleInit();
    // Adapter is still set up (read-only EVM adapter)...
    expect(() => svc.getAdapter("arc-testnet")).not.toThrow();
    // ...but no signer is loaded.
    expect(() => svc.getEvmAccount("arc-testnet")).toThrow(/No EVM signer loaded/);
    // Warn message names the network and cites Phase 2.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/arc-testnet.*Secret Manager.*Phase 2/),
    );
    warnSpy.mockRestore();
  });

  it("getAdapter throws for a network not in the map", () => {
    const svc = new AdaptersService(makeConfig());
    svc.onModuleInit();
    expect(() => svc.getAdapter("solana-mainnet")).toThrow(/No adapter for network/);
  });

  // 2026-05-27 smoke F3 regression: settler .env carrying
  // PACT_SETTLER_KEYPAIR_<NETWORK> without that network in
  // PACT_ENABLED_NETWORKS used to silently boot only solana-devnet. The guard
  // must emit a loud warn with the offending env key + network name.
  it("warns loudly when PACT_SETTLER_KEYPAIR_* is set for a network not in PACT_ENABLED_NETWORKS (smoke F3)", () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    const svc = new AdaptersService(
      makeConfig({
        // Default PACT_ENABLED_NETWORKS (= solana-devnet only)
        PACT_SETTLER_KEYPAIR_ARC_TESTNET:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        PACT_SETTLER_KEYPAIR_BASE_SEPOLIA:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    );
    svc.onModuleInit();

    // The warn must name both orphan env keys (so an operator grepping the
    // boot log can locate the misconfiguration directly).
    const warnCalls = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("orphan signer env"));
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toMatch(/PACT_SETTLER_KEYPAIR_ARC_TESTNET/);
    expect(warnCalls[0]).toMatch(/PACT_SETTLER_KEYPAIR_BASE_SEPOLIA/);
    expect(warnCalls[0]).toMatch(/arc-testnet/);
    expect(warnCalls[0]).toMatch(/base-sepolia/);

    warnSpy.mockRestore();
  });

  // 2026-05-27 smoke F3 regression: when PACT_ENABLED_NETWORKS DOES include
  // the network, no orphan warn must fire — otherwise the warn floods every
  // healthy multi-network boot and operators learn to ignore it.
  it("does NOT warn when PACT_SETTLER_KEYPAIR_* matches an enabled network (smoke F3)", () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet,base-sepolia",
        PACT_SETTLER_KEYPAIR_ARC_TESTNET:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        PACT_SETTLER_KEYPAIR_BASE_SEPOLIA:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    );
    svc.onModuleInit();

    const orphanWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("orphan signer env"));
    expect(orphanWarns).toEqual([]);
    warnSpy.mockRestore();
  });
});
