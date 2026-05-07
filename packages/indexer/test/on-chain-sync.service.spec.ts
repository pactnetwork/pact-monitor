import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ENDPOINT_CONFIG_LEN } from "@pact-network/protocol-v1-client";
import { PublicKey } from "@solana/web3.js";
import {
  OnChainSyncService,
  slugBytesToString,
} from "../src/sync/on-chain-sync.service";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * Build a 544-byte EndpointConfig buffer matching the layout in
 * `state.rs::EndpointConfig` and `decodeEndpointConfig`. Only fills the
 * fields the indexer cares about; everything else stays zero.
 */
interface EndpointFixture {
  slug: string;
  paused?: boolean;
  flatPremiumLamports?: bigint;
  percentBps?: number;
  slaLatencyMs?: number;
  imputedCostLamports?: bigint;
  exposureCapPerHourLamports?: bigint;
  feeRecipientCount?: number;
}

function buildEndpointConfigBuffer(f: EndpointFixture): Buffer {
  const buf = Buffer.alloc(ENDPOINT_CONFIG_LEN);
  // bump (offset 0)
  buf.writeUInt8(255, 0);
  // paused (offset 1)
  buf.writeUInt8(f.paused ? 1 : 0, 1);
  // slug at offset 8..24 (16 bytes, NUL-padded)
  const slugBytes = Buffer.from(f.slug, "utf-8");
  if (slugBytes.length > 16) throw new Error("slug too long");
  slugBytes.copy(buf, 8);
  // flat_premium_lamports u64 LE at 24
  buf.writeBigUInt64LE(f.flatPremiumLamports ?? 0n, 24);
  // percent_bps u16 LE at 32
  buf.writeUInt16LE(f.percentBps ?? 0, 32);
  // sla_latency_ms u32 LE at 40
  buf.writeUInt32LE(f.slaLatencyMs ?? 0, 40);
  // imputed_cost_lamports u64 LE at 48
  buf.writeBigUInt64LE(f.imputedCostLamports ?? 0n, 48);
  // exposure_cap_per_hour_lamports u64 LE at 56
  buf.writeBigUInt64LE(f.exposureCapPerHourLamports ?? 0n, 56);
  // fee_recipient_count u8 at 152
  buf.writeUInt8(f.feeRecipientCount ?? 0, 152);
  return buf;
}

function fakeAccount(f: EndpointFixture) {
  return {
    pubkey: new PublicKey("11111111111111111111111111111111"),
    account: {
      data: buildEndpointConfigBuffer(f),
      executable: false,
      lamports: 0,
      owner: new PublicKey("11111111111111111111111111111111"),
    },
  };
}

describe("slugBytesToString", () => {
  it("strips trailing NUL padding from a 16-byte slug array", () => {
    const bytes = new Uint8Array(16);
    Buffer.from("helius", "utf-8").copy(bytes);
    expect(slugBytesToString(bytes)).toBe("helius");
  });

  it("returns the full string when no NUL padding is present", () => {
    const bytes = new Uint8Array(16);
    Buffer.from("sixteen-bytes-x!", "utf-8").copy(bytes);
    expect(slugBytesToString(bytes)).toBe("sixteen-bytes-x!");
  });

  it("returns empty for an all-zero buffer", () => {
    expect(slugBytesToString(new Uint8Array(16))).toBe("");
  });
});

describe("OnChainSyncService", () => {
  let svc: OnChainSyncService;
  let prismaUpsert: jest.Mock;
  let getProgramAccounts: jest.Mock;

  beforeEach(async () => {
    prismaUpsert = jest.fn().mockResolvedValue({});
    getProgramAccounts = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnChainSyncService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === "SOLANA_RPC_URL")
                return "https://api.mainnet-beta.solana.com";
              if (key === "PROGRAM_ID") return undefined;
              return undefined;
            },
          },
        },
        {
          provide: PrismaService,
          useValue: { endpoint: { upsert: prismaUpsert } },
        },
      ],
    }).compile();

    svc = module.get(OnChainSyncService);
    // Stub the Connection.getProgramAccounts method on the private member.
    (svc as unknown as { connection: { getProgramAccounts: jest.Mock } }).connection.getProgramAccounts =
      getProgramAccounts;
  });

  it("empty chain — no upserts, logs zero", async () => {
    getProgramAccounts.mockResolvedValueOnce([]);
    await svc.syncEndpointsFromChain();
    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(prismaUpsert).not.toHaveBeenCalled();
  });

  it("single endpoint — decodes and upserts with on-chain values", async () => {
    getProgramAccounts.mockResolvedValueOnce([
      fakeAccount({
        slug: "helius",
        paused: false,
        flatPremiumLamports: 1000n,
        percentBps: 250,
        slaLatencyMs: 800,
        imputedCostLamports: 5_000n,
        exposureCapPerHourLamports: 10_000_000n,
      }),
    ]);

    await svc.syncEndpointsFromChain();
    expect(prismaUpsert).toHaveBeenCalledTimes(1);
    const args = prismaUpsert.mock.calls[0][0];
    expect(args.where).toEqual({ slug: "helius" });
    expect(args.create.slug).toBe("helius");
    expect(args.create.flatPremiumLamports).toBe(1000n);
    expect(args.create.percentBps).toBe(250);
    expect(args.create.slaLatencyMs).toBe(800);
    expect(args.create.imputedCostLamports).toBe(5_000n);
    expect(args.create.exposureCapPerHourLamports).toBe(10_000_000n);
    expect(args.create.paused).toBe(false);
    // Update path mirrors create on the on-chain-derived fields, leaves
    // upstreamBase / displayName / logoUrl alone.
    expect(args.update.flatPremiumLamports).toBe(1000n);
    expect(args.update.paused).toBe(false);
    expect(args.update).not.toHaveProperty("upstreamBase");
    expect(args.update).not.toHaveProperty("displayName");
    expect(args.update).not.toHaveProperty("logoUrl");
  });

  it("five endpoints (mainnet shape) — upserts each by slug", async () => {
    const slugs = ["helius", "birdeye", "jupiter", "elfa", "fal"];
    getProgramAccounts.mockResolvedValueOnce(
      slugs.map((slug, i) =>
        fakeAccount({
          slug,
          paused: i % 2 === 0,
          flatPremiumLamports: BigInt(100 * (i + 1)),
          percentBps: 100 + i,
          slaLatencyMs: 1000 + i,
        }),
      ),
    );

    await svc.syncEndpointsFromChain();
    expect(prismaUpsert).toHaveBeenCalledTimes(5);
    const seen = prismaUpsert.mock.calls.map((c) => c[0].where.slug);
    expect(seen.sort()).toEqual([...slugs].sort());
  });

  it("RPC error does not crash — error is caught and logged", async () => {
    getProgramAccounts.mockRejectedValueOnce(new Error("RPC unavailable"));
    // No throw expected.
    await expect(svc.syncEndpointsFromChain()).resolves.toBeUndefined();
    expect(prismaUpsert).not.toHaveBeenCalled();
  });

  it("isRunning guard prevents concurrent syncs", async () => {
    let resolveFirst: () => void = () => {};
    const firstStarted = new Promise<void>((res) => {
      getProgramAccounts.mockImplementationOnce(
        () =>
          new Promise((resolveAccounts) => {
            res();
            resolveFirst = () => resolveAccounts([]);
          }),
      );
    });

    const first = svc.syncEndpointsFromChain();
    await firstStarted;
    // Second call MUST early-return without invoking RPC.
    await svc.syncEndpointsFromChain();
    expect(getProgramAccounts).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
  });

  it("decoder field-name mapping — uses on-chain paused bit, not forced true", async () => {
    getProgramAccounts.mockResolvedValueOnce([
      fakeAccount({ slug: "paused-ep", paused: true, flatPremiumLamports: 42n }),
      fakeAccount({ slug: "live-ep", paused: false, flatPremiumLamports: 99n }),
    ]);
    await svc.syncEndpointsFromChain();
    const upserts = prismaUpsert.mock.calls.map((c) => c[0]);
    const paused = upserts.find((u) => u.where.slug === "paused-ep");
    const live = upserts.find((u) => u.where.slug === "live-ep");
    expect(paused?.create.paused).toBe(true);
    expect(live?.create.paused).toBe(false);
  });
});
