/**
 * AdaptersService (indexer) bootstrap tests — WP-MN-03b T3
 *
 * Uses Jest (indexer's test framework) with manual mocks for
 * @pact-network/shared so no real RPC or filesystem is touched.
 */

// ---------------------------------------------------------------------------
// Manual mock for @pact-network/shared
// ---------------------------------------------------------------------------
const mockSolanaAdapterInstances: object[] = [];
const mockEvmAdapterInstances: object[] = [];

jest.mock("@pact-network/shared", () => {
  const CHAINS: Record<string, { vm: string; network: string; usdcMint: string; usdcDecimals: number; chainId?: number; rpcUrl?: string; finalityBlocks?: number; blockTimeMs?: number; deploymentBlock?: number }> = {
    "solana-devnet": { vm: "solana", network: "solana-devnet", usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", usdcDecimals: 6 },
    "arc-testnet":   { vm: "evm",    network: "arc-testnet",   usdcMint: "0x0", usdcDecimals: 6, chainId: 5042002, rpcUrl: "https://rpc.testnet.arc.network", finalityBlocks: 64, blockTimeMs: 500, deploymentBlock: 42953139 },
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

  class EvmAdapter {
    descriptor: object;
    constructor(opts: { descriptor: object }) {
      this.descriptor = opts.descriptor;
      mockEvmAdapterInstances.push(this);
    }
  }

  return { getChain, SolanaAdapter, EvmAdapter };
});

// ---------------------------------------------------------------------------
// Mock @pact-network/protocol-evm-v1-client so resolveDeployment is a no-op
// ---------------------------------------------------------------------------
jest.mock("@pact-network/protocol-evm-v1-client", () => ({
  resolveDeployment: jest.fn().mockReturnValue({
    chainId: 5042002,
    usdc: "0x3600000000000000000000000000000000000000",
    registry: "0x056BAC33546b5b51B8CF6f332379651f715B889C",
    pool: "0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE",
    settler: "0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f",
  }),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AdaptersService } from "../src/adapters/adapters.service";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeConfig(env: Record<string, string> = {}): Partial<ConfigService> {
  return {
    get: jest.fn().mockImplementation((k: string) => env[k] ?? undefined),
    getOrThrow: jest.fn().mockImplementation((k: string) => {
      if (!env[k]) throw new Error(`missing ${k}`);
      return env[k];
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdaptersService (indexer)", () => {
  beforeEach(() => {
    mockSolanaAdapterInstances.length = 0;
    mockEvmAdapterInstances.length = 0;
  });

  async function buildSvc(env: Record<string, string> = {}): Promise<AdaptersService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdaptersService,
        { provide: ConfigService, useValue: makeConfig(env) },
      ],
    }).compile();
    return module.get(AdaptersService);
  }

  it("default boot (no PACT_ENABLED_NETWORKS): exactly 1 entry, solana-devnet, vm=solana", async () => {
    const svc = await buildSvc();
    svc.onModuleInit();

    expect(svc.listEnabledNetworks()).toEqual(["solana-devnet"]);
    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterInstances).toHaveLength(0);
  });

  it("PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet: 2 entries, second is real EvmAdapter (read-only)", async () => {
    const svc = await buildSvc({ PACT_ENABLED_NETWORKS: "solana-devnet,arc-testnet" });
    svc.onModuleInit();

    const networks = svc.listEnabledNetworks();
    expect(networks).toHaveLength(2);
    expect(networks).toContain("solana-devnet");
    expect(networks).toContain("arc-testnet");
    expect(mockSolanaAdapterInstances).toHaveLength(1);
    expect(mockEvmAdapterInstances).toHaveLength(1);

    const arcAdapter = svc.getAdapter("arc-testnet");
    expect(mockEvmAdapterInstances).toContain(arcAdapter);
  });

  it("PACT_ENABLED_NETWORKS=bogus-chain: throws via getChain (unknown network)", async () => {
    const svc = await buildSvc({ PACT_ENABLED_NETWORKS: "bogus-chain" });
    expect(() => svc.onModuleInit()).toThrow(/unknown network "bogus-chain"/);
  });

  it("PACT_LEGACY_DIRECT_SOLANA=true: flag captured", async () => {
    const svc = await buildSvc({ PACT_LEGACY_DIRECT_SOLANA: "true" });
    expect(svc.legacyDirectSolana).toBe(true);
  });

  it("PACT_LEGACY_DIRECT_SOLANA absent: flag is false", async () => {
    const svc = await buildSvc();
    expect(svc.legacyDirectSolana).toBe(false);
  });
});
