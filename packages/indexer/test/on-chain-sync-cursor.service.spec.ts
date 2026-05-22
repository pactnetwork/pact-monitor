import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OnChainSyncService } from "../src/sync/on-chain-sync.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { AdaptersService } from "../src/adapters/adapters.service";

/**
 * Multi-EVM WP T3: the indexer's 5-min config sync must resume its
 * EndpointRegistered discovery scan from a persisted per-network cursor instead
 * of re-walking from deploymentBlock every tick. These tests exercise the
 * adapter (cursor) path with a mocked adapter + mocked Prisma; they assert the
 * fromBlock the adapter receives and the cursor persisted afterward.
 */
describe("OnChainSyncService — per-network sync cursor (multi-evm WP T3)", () => {
  // arc-testnet getChain().deploymentBlock (chains.json).
  const DEPLOYMENT_BLOCK = 42_953_139n;
  const SCANNED_TO = 43_000_000n;

  let svc: OnChainSyncService;
  let syncCursorFindUnique: jest.Mock;
  let syncCursorUpsert: jest.Mock;
  let endpointFindMany: jest.Mock;
  let endpointUpsert: jest.Mock;
  let readEndpointConfigsFrom: jest.Mock;

  beforeEach(async () => {
    syncCursorFindUnique = jest.fn();
    syncCursorUpsert = jest.fn().mockResolvedValue({});
    endpointFindMany = jest.fn().mockResolvedValue([]);
    endpointUpsert = jest.fn().mockResolvedValue({});
    readEndpointConfigsFrom = jest
      .fn()
      .mockResolvedValue({ snapshots: [], scannedToBlock: SCANNED_TO });

    const adapter = {
      descriptor: { vm: "evm" },
      readEndpointConfigs: jest.fn(),
      readEndpointConfigsFrom,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnChainSyncService,
        {
          provide: ConfigService,
          useValue: { get: (_k: string) => undefined },
        },
        {
          provide: PrismaService,
          useValue: {
            endpoint: { upsert: endpointUpsert, findMany: endpointFindMany },
            syncCursor: {
              findUnique: syncCursorFindUnique,
              upsert: syncCursorUpsert,
            },
          },
        },
        {
          provide: AdaptersService,
          useValue: {
            legacyDirectSolana: false,
            listEnabledNetworks: () => ["arc-testnet"],
            getAdapter: () => adapter,
          },
        },
      ],
    }).compile();

    svc = module.get(OnChainSyncService);
  });

  it("cold start (no cursor) scans from deploymentBlock and persists scannedToBlock", async () => {
    syncCursorFindUnique.mockResolvedValue(null);

    await svc.refreshAllNetworks();

    expect(readEndpointConfigsFrom).toHaveBeenCalledTimes(1);
    expect(readEndpointConfigsFrom.mock.calls[0][0]).toBe(DEPLOYMENT_BLOCK);

    expect(syncCursorUpsert).toHaveBeenCalledTimes(1);
    const up = syncCursorUpsert.mock.calls[0][0];
    expect(up.where).toEqual({ network: "arc-testnet" });
    expect(up.create.lastScannedBlock).toBe(SCANNED_TO);
    expect(up.update.lastScannedBlock).toBe(SCANNED_TO);
  });

  it("second pass resumes from the stored cursor + 1, NOT deploymentBlock", async () => {
    syncCursorFindUnique.mockResolvedValue({
      network: "arc-testnet",
      lastScannedBlock: SCANNED_TO,
    });

    await svc.refreshAllNetworks();

    expect(readEndpointConfigsFrom.mock.calls[0][0]).toBe(SCANNED_TO + 1n);
    expect(readEndpointConfigsFrom.mock.calls[0][0]).not.toBe(DEPLOYMENT_BLOCK);
  });

  it("threads the indexer's known slugs into the refresh set", async () => {
    syncCursorFindUnique.mockResolvedValue(null);
    endpointFindMany.mockResolvedValue([{ slug: "0xabc" }, { slug: "0xdef" }]);

    await svc.refreshAllNetworks();

    expect(endpointFindMany).toHaveBeenCalledWith({
      where: { network: "arc-testnet" },
      select: { slug: true },
    });
    expect(readEndpointConfigsFrom.mock.calls[0][1]).toEqual(["0xabc", "0xdef"]);
  });
});
