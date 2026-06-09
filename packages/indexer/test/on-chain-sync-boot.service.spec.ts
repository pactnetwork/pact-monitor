/**
 * EVM-only boot for OnChainSyncService (agent-tasks#14).
 *
 * The indexer must bootstrap when no solana-* network is enabled WITHOUT
 * reading SOLANA_RPC_URL / PROGRAM_ID, WITHOUT building the Solana Connection,
 * and WITHOUT firing the legacy getProgramAccounts boot sync. When a Solana
 * network IS enabled the legacy path is built exactly as before. Mirrors the
 * settler's "boot without Solana" test (pact-monitor#258).
 *
 * The combined block at the bottom boots the REAL AdaptersService alongside the
 * REAL OnChainSyncService for a base-mainnet-only config to prove the whole sync
 * boot path comes up base-only and routes base-mainnet through the adapter path,
 * not Solana.
 */

// ---------------------------------------------------------------------------
// Manual mock for @pact-network/shared — base-mainnet (EVM) + a solana network,
// no real RPC. Same shape as test/adapters.service.spec.ts.
// ---------------------------------------------------------------------------
const mockSolanaAdapterInstances: object[] = [];
const mockEvmAdapterInstances: object[] = [];

jest.mock("@pact-network/shared", () => {
  const CHAINS: Record<
    string,
    {
      vm: string;
      network: string;
      usdcMint: string;
      usdcDecimals: number;
      chainId?: number;
      rpcUrl?: string;
      finalityBlocks?: number;
      blockTimeMs?: number;
      deploymentBlock?: number;
    }
  > = {
    "solana-devnet": {
      vm: "solana",
      network: "solana-devnet",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      usdcDecimals: 6,
    },
    "base-mainnet": {
      vm: "evm",
      network: "base-mainnet",
      usdcMint: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      usdcDecimals: 6,
      chainId: 8453,
      rpcUrl: "https://mainnet.base.org",
      finalityBlocks: 64,
      blockTimeMs: 2000,
      deploymentBlock: 46000000,
    },
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
    // OnChainSyncService probes for this cursor method; absence routes
    // base-mainnet through the plain readEndpointConfigs path.
    readEndpointConfigs = jest.fn().mockResolvedValue([]);
  }

  return { getChain, SolanaAdapter, EvmAdapter };
});

jest.mock("@pact-network/protocol-evm-v1-client", () => ({
  resolveDeployment: jest.fn().mockReturnValue({
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    registry: "0x056BAC33546b5b51B8CF6f332379651f715B889C",
    pool: "0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE",
    settler: "0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f",
  }),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OnChainSyncService } from "../src/sync/on-chain-sync.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { AdaptersService } from "../src/adapters/adapters.service";

/**
 * Env-backed ConfigService stub whose getOrThrow throws for EVERYTHING — so any
 * accidental hard-require of a Solana env on the EVM-only path fails the test.
 * `getCalls` records every `get(key)` so we can assert SOLANA_RPC_URL / PROGRAM_ID
 * are never consulted on the EVM-only path.
 */
function makeConfig(env: Record<string, string | undefined> = {}): {
  config: ConfigService;
  getCalls: string[];
} {
  const getCalls: string[] = [];
  const config = {
    get: jest.fn((k: string) => {
      getCalls.push(k);
      return env[k];
    }),
    getOrThrow: jest.fn((k: string) => {
      throw new Error(`getOrThrow must not be called on the boot path: ${k}`);
    }),
  } as unknown as ConfigService;
  return { config, getCalls };
}

function stubPrisma(): PrismaService {
  return {
    endpoint: { upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    syncCursor: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
  } as unknown as PrismaService;
}

function stubAdapters(overrides: Partial<AdaptersService> = {}): AdaptersService {
  return {
    legacyDirectSolana: false,
    listEnabledNetworks: () => ["base-mainnet"],
    getAdapter: () => {
      throw new Error("stub: adapter path not expected in this test");
    },
    ...overrides,
  } as unknown as AdaptersService;
}

describe("OnChainSyncService — boot without Solana (agent-tasks#14)", () => {
  beforeEach(() => {
    mockSolanaAdapterInstances.length = 0;
    mockEvmAdapterInstances.length = 0;
  });

  it("boots EVM-only (base-mainnet) without reading SOLANA_RPC_URL / PROGRAM_ID and without building a Connection", () => {
    const { config, getCalls } = makeConfig({
      PACT_ENABLED_NETWORKS: "base-mainnet",
      PACT_RPC_URL_BASE_MAINNET: "https://mainnet.base.org",
    });

    const svc = new OnChainSyncService(config, stubPrisma(), stubAdapters());

    // No Solana RPC Connection / programId built.
    expect((svc as unknown as { connection: unknown }).connection).toBeNull();
    expect((svc as unknown as { programId: unknown }).programId).toBeNull();
    // The Solana env is never consulted on the EVM-only path.
    expect(getCalls).not.toContain("SOLANA_RPC_URL");
    expect(getCalls).not.toContain("PROGRAM_ID");
    // getOrThrow is never used anywhere in the indexer boot path.
    expect(config.getOrThrow).not.toHaveBeenCalled();
  });

  it("EVM-only onModuleInit does not throw and does not fire the legacy boot sync", () => {
    const { config } = makeConfig({
      PACT_ENABLED_NETWORKS: "base-mainnet",
      PACT_RPC_URL_BASE_MAINNET: "https://mainnet.base.org",
    });
    const svc = new OnChainSyncService(config, stubPrisma(), stubAdapters());
    const syncSpy = jest
      .spyOn(svc, "syncEndpointsFromChain")
      .mockResolvedValue(undefined);

    expect(() => svc.onModuleInit()).not.toThrow();
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("still builds the Solana path when a Solana network is enabled (default unset → solana-devnet)", () => {
    // PACT_ENABLED_NETWORKS unset defaults to solana-devnet → Solana deps built.
    const { config } = makeConfig({
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
    });
    const svc = new OnChainSyncService(config, stubPrisma(), stubAdapters());
    expect((svc as unknown as { connection: unknown }).connection).not.toBeNull();
    expect((svc as unknown as { programId: unknown }).programId).not.toBeNull();
  });

  it("still builds the Solana path for a unified solana+base config (no regression)", () => {
    const { config } = makeConfig({
      PACT_ENABLED_NETWORKS: "solana-devnet,base-mainnet",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
    });
    const svc = new OnChainSyncService(config, stubPrisma(), stubAdapters());
    expect((svc as unknown as { connection: unknown }).connection).not.toBeNull();
    expect((svc as unknown as { programId: unknown }).programId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Whole-sync-boot-path test: REAL AdaptersService + REAL OnChainSyncService for
// a base-mainnet-only config. Proves the indexer's sync boot path comes up
// base-only (adapter bootstrapped, Solana skipped) and the cron refresh routes
// base-mainnet through the adapter path.
// ---------------------------------------------------------------------------
describe("Indexer sync boot path — base-mainnet only (agent-tasks#14)", () => {
  beforeEach(() => {
    mockSolanaAdapterInstances.length = 0;
    mockEvmAdapterInstances.length = 0;
  });

  it("AdaptersService + OnChainSyncService both boot base-only; refresh uses the adapter path, not Solana", async () => {
    const env: Record<string, string | undefined> = {
      PACT_ENABLED_NETWORKS: "base-mainnet",
      PACT_RPC_URL_BASE_MAINNET: "https://mainnet.base.org",
    };
    const getCalls: string[] = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdaptersService,
        OnChainSyncService,
        { provide: PrismaService, useValue: stubPrisma() },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) => {
              getCalls.push(k);
              return env[k];
            }),
            getOrThrow: jest.fn((k: string) => {
              throw new Error(`getOrThrow must not be called on boot path: ${k}`);
            }),
          },
        },
      ],
    }).compile();

    const adapters = module.get(AdaptersService);
    adapters.onModuleInit();
    expect(adapters.listEnabledNetworks()).toEqual(["base-mainnet"]);
    expect(mockEvmAdapterInstances).toHaveLength(1);
    expect(mockSolanaAdapterInstances).toHaveLength(0);

    const sync = module.get(OnChainSyncService);
    expect((sync as unknown as { connection: unknown }).connection).toBeNull();

    // Boot sync is a no-op (no Solana) and must not throw.
    expect(() => sync.onModuleInit()).not.toThrow();

    // The 5-minute cron refresh must walk base-mainnet via the adapter path.
    await expect(sync.refreshAllNetworks()).resolves.toBeUndefined();
    const evmAdapter = mockEvmAdapterInstances[0] as {
      readEndpointConfigs: jest.Mock;
    };
    expect(evmAdapter.readEndpointConfigs).toHaveBeenCalledTimes(1);

    // The Solana env is never consulted anywhere in this boot path.
    expect(getCalls).not.toContain("SOLANA_RPC_URL");
    expect(getCalls).not.toContain("PROGRAM_ID");
  });
});
