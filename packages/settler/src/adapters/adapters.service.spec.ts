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
  const CHAINS: Record<string, { vm: string; network: string; usdcMint: string; usdcDecimals: number; chainId: number; rpcUrl: string; finalityBlocks: number; blockTimeMs: number; deploymentBlock: number | null }> = {
    "solana-devnet": { vm: "solana", network: "solana-devnet", usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", usdcDecimals: 6, chainId: 0, rpcUrl: "", finalityBlocks: 0, blockTimeMs: 0, deploymentBlock: 0 },
    "arc-testnet":   { vm: "evm",    network: "arc-testnet",   usdcMint: "0x0", usdcDecimals: 6, chainId: 5042002, rpcUrl: "https://rpc.testnet.arc.network", finalityBlocks: 64, blockTimeMs: 500, deploymentBlock: 42953139 },
    "arc-mainnet":   { vm: "evm",    network: "arc-mainnet",   usdcMint: "0x0", usdcDecimals: 6, chainId: 5042,    rpcUrl: "https://rpc.mainnet.arc.io",    finalityBlocks: 64, blockTimeMs: 500, deploymentBlock: null },
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
    maxFeePerGasWei?: bigint;
    constructor(opts: { descriptor: object; rpcUrl?: string; maxFeePerGasWei?: bigint }) {
      this.descriptor = opts.descriptor;
      this.rpcUrl = opts.rpcUrl;
      this.maxFeePerGasWei = opts.maxFeePerGasWei;
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
// Mock @google-cloud/secret-manager: one shared accessSecretVersion spy so each
// test controls what a "projects/..." PACT_SETTLER_KEYPAIR_<NETWORK> resolves to.
// ---------------------------------------------------------------------------
const { mockAccessSecretVersion } = vi.hoisted(() => ({
  mockAccessSecretVersion: vi.fn(),
}));
vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
    accessSecretVersion: mockAccessSecretVersion,
  })),
}));

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
    mockAccessSecretVersion.mockReset();
  });

  it("default boot (no PACT_ENABLED_NETWORKS): exactly 1 entry, solana-devnet, vm=solana", async () => {
    const svc = new AdaptersService(makeConfig());
    await svc.onModuleInit();

    expect(svc.listEnabledNetworks()).toEqual(["solana-devnet"]);
    const adapter = svc.getAdapter("solana-devnet");
    expect(adapter).toBeDefined();
    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterInstances).toHaveLength(0);
  });

  it("PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet: 2 entries, second is EvmAdapter", async () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    await svc.onModuleInit();

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

  it("EVM RPC override: PACT_RPC_URL_<CHAIN> beats the chain registry rpcUrl", async () => {
    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "arc-testnet",
        PACT_RPC_URL_ARC_TESTNET: "https://paid.example/arc",
      }),
    );
    await svc.onModuleInit();

    const arc = svc.getAdapter("arc-testnet") as unknown as { rpcUrl: string };
    expect(arc.rpcUrl).toBe("https://paid.example/arc");
  });

  it("EVM RPC default: no override falls back to the chain registry rpcUrl", async () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "arc-testnet" }),
    );
    await svc.onModuleInit();

    const arc = svc.getAdapter("arc-testnet") as unknown as { rpcUrl: string };
    expect(arc.rpcUrl).toBe("https://rpc.testnet.arc.network");
  });

  it("EVM fee ceiling: per-chain PACT_EVM_MAX_FEE_PER_GAS_WEI_<CHAIN> beats the global key", async () => {
    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "arc-testnet",
        PACT_EVM_MAX_FEE_PER_GAS_WEI_ARC_TESTNET: "50000000000",
        PACT_EVM_MAX_FEE_PER_GAS_WEI: "1",
      }),
    );
    await svc.onModuleInit();

    const arc = svc.getAdapter("arc-testnet") as unknown as { maxFeePerGasWei?: bigint };
    expect(arc.maxFeePerGasWei).toBe(50_000_000_000n);
  });

  it("EVM fee ceiling: global PACT_EVM_MAX_FEE_PER_GAS_WEI applies when no per-chain key is set", async () => {
    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "arc-testnet,base-sepolia",
        PACT_EVM_MAX_FEE_PER_GAS_WEI: "30000000000",
        PACT_EVM_MAX_FEE_PER_GAS_WEI_BASE_SEPOLIA: "2000000000",
      }),
    );
    await svc.onModuleInit();

    const arc = svc.getAdapter("arc-testnet") as unknown as { maxFeePerGasWei?: bigint };
    const base = svc.getAdapter("base-sepolia") as unknown as { maxFeePerGasWei?: bigint };
    expect(arc.maxFeePerGasWei).toBe(30_000_000_000n);
    expect(base.maxFeePerGasWei).toBe(2_000_000_000n);
  });

  it("EVM fee ceiling: unset leaves the adapter uncapped", async () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "arc-testnet" }),
    );
    await svc.onModuleInit();

    const arc = svc.getAdapter("arc-testnet") as unknown as { maxFeePerGasWei?: bigint };
    expect(arc.maxFeePerGasWei).toBeUndefined();
  });

  it.each(["20 gwei", "1e10", "-5", "0", "0x4a817c800", "1.5"])(
    "EVM fee ceiling: malformed value %s fails boot naming the source key",
    async (bad) => {
      const svc = new AdaptersService(
        makeConfig({
          PACT_ENABLED_NETWORKS: "arc-testnet",
          PACT_EVM_MAX_FEE_PER_GAS_WEI_ARC_TESTNET: bad,
        }),
      );
      await expect(svc.onModuleInit()).rejects.toThrow(
        /PACT_EVM_MAX_FEE_PER_GAS_WEI_ARC_TESTNET=.* must be a positive base-10 integer/,
      );
    },
  );

  describe("arc-mainnet no-ceiling boot warning", () => {
    const ceilingWarns = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("NO gas-fee ceiling"));

    // arc-mainnet has deploymentBlock null in the registry, so boot throws
    // after the warn; the warn must still fire first.
    it("warns when arc-mainnet is enabled and neither ceiling key is set", async () => {
      const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const svc = new AdaptersService(
        makeConfig({ PACT_ENABLED_NETWORKS: "arc-mainnet" }),
      );
      await expect(svc.onModuleInit()).rejects.toThrow(/missing deploymentBlock/);

      const msgs = ceilingWarns(warnSpy);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatch(/arc-mainnet enabled with NO gas-fee ceiling/);
      expect(msgs[0]).toMatch(/PACT_EVM_MAX_FEE_PER_GAS_WEI_ARC_MAINNET/);
      warnSpy.mockRestore();
    });

    it.each([
      ["per-network key", { PACT_EVM_MAX_FEE_PER_GAS_WEI_ARC_MAINNET: "50000000000" }],
      ["global key", { PACT_EVM_MAX_FEE_PER_GAS_WEI: "50000000000" }],
    ])("no warn when the %s is set", async (_label, extra) => {
      const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const svc = new AdaptersService(
        makeConfig({ PACT_ENABLED_NETWORKS: "arc-mainnet", ...extra }),
      );
      await expect(svc.onModuleInit()).rejects.toThrow(/missing deploymentBlock/);
      expect(ceilingWarns(warnSpy)).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("no warn for other EVM networks without a ceiling", async () => {
      const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const svc = new AdaptersService(
        makeConfig({ PACT_ENABLED_NETWORKS: "arc-testnet,base-sepolia" }),
      );
      await svc.onModuleInit();
      expect(ceilingWarns(warnSpy)).toHaveLength(0);
      warnSpy.mockRestore();
    });
  });

  it("arc-mainnet cannot boot before deploy: registry has no deploymentBlock", async () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "arc-mainnet" }),
    );
    await expect(svc.onModuleInit()).rejects.toThrow(
      /evm network arc-mainnet missing deploymentBlock/,
    );
  });

  it("PACT_ENABLED_NETWORKS=bogus-chain: throws via getChain (unknown network)", async () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "bogus-chain" }),
    );
    await expect(svc.onModuleInit()).rejects.toThrow(/unknown network "bogus-chain"/);
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

  it("loadKeypair: parses a valid keypair JSON env var (PACT_SETTLER_KEYPAIR for solana-devnet)", async () => {
    const kp = Keypair.generate();
    const raw = JSON.stringify(Array.from(kp.secretKey));

    const svc = new AdaptersService(
      makeConfig({ PACT_SETTLER_KEYPAIR: raw }),
    );
    await svc.onModuleInit();

    const loaded = svc.getSigner("solana-devnet");
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("loadKeypair: PACT_SETTLER_KEYPAIR_SOLANA_DEVNET takes precedence over fallback", async () => {
    const kp1 = Keypair.generate();
    const kp2 = Keypair.generate();

    const svc = new AdaptersService(
      makeConfig({
        PACT_SETTLER_KEYPAIR: JSON.stringify(Array.from(kp1.secretKey)),
        PACT_SETTLER_KEYPAIR_SOLANA_DEVNET: JSON.stringify(Array.from(kp2.secretKey)),
      }),
    );
    await svc.onModuleInit();

    const loaded = svc.getSigner("solana-devnet");
    expect(loaded.publicKey.toBase58()).toBe(kp2.publicKey.toBase58());
  });

  it("getSigner throws for a network with no loaded keypair (EVM uses getEvmAccount, not getSigner)", async () => {
    // arc-testnet uses getEvmAccount() for EVM signers; getSigner() is Solana-only.
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    await svc.onModuleInit();
    expect(() => svc.getSigner("arc-testnet")).toThrow(/No settler signer loaded/);
  });

  it("loadEvmAccount: parses a valid 0x-hex private key for arc-testnet (Phase 1)", async () => {
    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet",
        PACT_SETTLER_KEYPAIR_ARC_TESTNET: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    );
    await svc.onModuleInit();

    // getEvmAccount does not throw when the key was loaded
    const account = svc.getEvmAccount("arc-testnet");
    expect(account).toBeDefined();
    expect(account.address).toBe("0xdeadbeef"); // from the mock
  });

  it("getEvmAccount throws when no EVM key is set", async () => {
    const svc = new AdaptersService(
      makeConfig({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" }),
    );
    await svc.onModuleInit();
    expect(() => svc.getEvmAccount("arc-testnet")).toThrow(/No EVM signer loaded/);
  });

  describe("loadEvmAccount: Secret Manager resource path", () => {
    const SM_PATH = "projects/test-gcp/secrets/pact-settler-arc-testnet/versions/latest";
    const FAKE_KEY = "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
    const smConfig = () =>
      makeConfig({
        PACT_ENABLED_NETWORKS: "arc-testnet",
        PACT_SETTLER_KEYPAIR_ARC_TESTNET: SM_PATH,
      });
    const loggedText = (...spies: ReturnType<typeof vi.spyOn>[]) =>
      spies.flatMap((spy) => spy.mock.calls.flat().map((a) => String(a))).join("\n");

    it("resolves the signer from the secret payload (Uint8Array)", async () => {
      mockAccessSecretVersion.mockResolvedValue([
        { payload: { data: Buffer.from(`${FAKE_KEY}\n`, "utf8") } },
      ]);
      const svc = new AdaptersService(smConfig());
      await svc.onModuleInit();

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(1);
      expect(mockAccessSecretVersion).toHaveBeenCalledWith({ name: SM_PATH });
      const account = svc.getEvmAccount("arc-testnet") as unknown as { _key: string };
      expect(account._key).toBe(FAKE_KEY);
    });

    it("resolves a string payload without a 0x prefix", async () => {
      mockAccessSecretVersion.mockResolvedValue([
        { payload: { data: FAKE_KEY.slice(2) } },
      ]);
      const svc = new AdaptersService(smConfig());
      await svc.onModuleInit();

      const account = svc.getEvmAccount("arc-testnet") as unknown as { _key: string };
      expect(account._key).toBe(FAKE_KEY);
    });

    it("does not call Secret Manager for a raw hex value", async () => {
      const svc = new AdaptersService(
        makeConfig({
          PACT_ENABLED_NETWORKS: "arc-testnet",
          PACT_SETTLER_KEYPAIR_ARC_TESTNET: FAKE_KEY,
        }),
      );
      await svc.onModuleInit();

      expect(mockAccessSecretVersion).not.toHaveBeenCalled();
      expect(svc.getEvmAccount("arc-testnet")).toBeDefined();
    });

    it.each([
      ["missing payload", [{}]],
      ["empty payload", [{ payload: { data: new Uint8Array(0) } }]],
      ["whitespace-only payload", [{ payload: { data: "  \n" } }]],
    ])("fails boot on %s", async (_label, response) => {
      mockAccessSecretVersion.mockResolvedValue(response);
      const svc = new AdaptersService(smConfig());

      await expect(svc.onModuleInit()).rejects.toThrow(
        /Empty Secret Manager payload for EVM signer arc-testnet/,
      );
      expect(() => svc.getEvmAccount("arc-testnet")).toThrow(/No EVM signer loaded/);
    });

    it("fails boot on an access error with a redacted message (name + gRPC code only)", async () => {
      const leaky = Object.assign(
        new Error(`PERMISSION_DENIED on ${SM_PATH}: payload ${FAKE_KEY}`),
        { name: "GoogleError", code: 7 },
      );
      mockAccessSecretVersion.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const svc = new AdaptersService(smConfig());

      const err = await svc.onModuleInit().then(
        () => null,
        (e: Error) => e,
      );

      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toBe(
        "Secret Manager access failed for EVM signer arc-testnet: GoogleError (code 7)",
      );
      expect(err?.message).not.toContain(FAKE_KEY.slice(2));
      expect(err?.message).not.toContain("PERMISSION_DENIED");
      expect(loggedText(warnSpy, logSpy, errorSpy)).not.toContain(FAKE_KEY.slice(2));
      warnSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("fails boot on a malformed secret payload with a redacted message (error name only)", async () => {
      const BAD_PAYLOAD = "0xnot-a-real-key-feedfacefeedface";
      mockAccessSecretVersion.mockResolvedValue([{ payload: { data: BAD_PAYLOAD } }]);
      const viemAccounts = await import("viem/accounts");
      vi.mocked(viemAccounts.privateKeyToAccount).mockImplementationOnce((key: string) => {
        const e = new Error(`Hex value "${key}" is not a valid private key`);
        e.name = "InvalidHexValueError";
        throw e;
      });
      const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const svc = new AdaptersService(smConfig());

      const err = await svc.onModuleInit().then(
        () => null,
        (e: Error) => e,
      );

      expect(err?.message).toBe(
        "Failed to parse EVM private key from Secret Manager for arc-testnet: InvalidHexValueError",
      );
      expect(() => svc.getEvmAccount("arc-testnet")).toThrow(/No EVM signer loaded/);
      expect(loggedText(warnSpy)).not.toContain("feedfacefeedface");
      warnSpy.mockRestore();
    });
  });

  it("loadEvmAccount: a malformed raw env key warns with the error name only and boots without a signer", async () => {
    const BAD_RAW = "0xnot-a-real-key-feedfacefeedface";
    const viemAccounts = await import("viem/accounts");
    vi.mocked(viemAccounts.privateKeyToAccount).mockImplementationOnce((key: string) => {
      const e = new Error(`Hex value "${key}" is not a valid private key`);
      e.name = "InvalidHexValueError";
      throw e;
    });
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const svc = new AdaptersService(
      makeConfig({
        PACT_ENABLED_NETWORKS: "arc-testnet",
        PACT_SETTLER_KEYPAIR_ARC_TESTNET: BAD_RAW,
      }),
    );
    await svc.onModuleInit();

    expect(mockAccessSecretVersion).not.toHaveBeenCalled();
    expect(() => svc.getEvmAccount("arc-testnet")).toThrow(/No EVM signer loaded/);
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to parse EVM private key for arc-testnet: InvalidHexValueError",
    );
    expect(
      warnSpy.mock.calls.flat().map((a) => String(a)).join("\n"),
    ).not.toContain("feedfacefeedface");
    warnSpy.mockRestore();
  });

  it("getAdapter throws for a network not in the map", async () => {
    const svc = new AdaptersService(makeConfig());
    await svc.onModuleInit();
    expect(() => svc.getAdapter("solana-mainnet")).toThrow(/No adapter for network/);
  });

  // 2026-05-27 smoke F3 regression: settler .env carrying
  // PACT_SETTLER_KEYPAIR_<NETWORK> without that network in
  // PACT_ENABLED_NETWORKS used to silently boot only solana-devnet. The guard
  // must emit a loud warn with the offending env key + network name.
  it("warns loudly when PACT_SETTLER_KEYPAIR_* is set for a network not in PACT_ENABLED_NETWORKS (smoke F3)", async () => {
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
    await svc.onModuleInit();

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
  it("does NOT warn when PACT_SETTLER_KEYPAIR_* matches an enabled network (smoke F3)", async () => {
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
    await svc.onModuleInit();

    const orphanWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("orphan signer env"));
    expect(orphanWarns).toEqual([]);
    warnSpy.mockRestore();
  });
});
