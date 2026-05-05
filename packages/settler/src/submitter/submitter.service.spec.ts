import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  BatchSubmitError,
  SubmitterService,
} from "./submitter.service";
import { SecretLoaderService } from "../config/secret-loader.service";
import { SettleBatch } from "../batcher/batcher.service";
import { SettleMessage } from "../consumer/consumer.service";
import {
  FeeRecipientKind,
  type EndpointConfig,
  type CoveragePool,
  type Treasury,
} from "@pact-network/protocol-v1-client";

// ---------------------------------------------------------------------------
// Mock the chain plumbing. We keep web3.js's PublicKey real so derivations and
// equality checks work end-to-end; we only stub Connection + sendAndConfirm.
// ---------------------------------------------------------------------------

const sendAndConfirmMock = vi.fn();
const getAccountInfoMock = vi.fn();

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    sendAndConfirmTransaction: (...args: unknown[]) => sendAndConfirmMock(...args),
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: getAccountInfoMock,
    })),
  };
});

// Mock the protocol-v1-client decoders so we can inject deterministic
// EndpointConfig + Treasury snapshots without serialising real layouts.
const decodeEndpointConfigMock = vi.fn();
const decodeCoveragePoolMock = vi.fn();
const decodeTreasuryMock = vi.fn();
const buildSettleBatchIxMock = vi.fn();

vi.mock("@pact-network/protocol-v1-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@pact-network/protocol-v1-client")
  >();
  return {
    ...actual,
    buildSettleBatchIx: (...args: unknown[]) => buildSettleBatchIxMock(...args),
    decodeEndpointConfig: (...args: unknown[]) => decodeEndpointConfigMock(...args),
    decodeCoveragePool: (...args: unknown[]) => decodeCoveragePoolMock(...args),
    decodeTreasury: (...args: unknown[]) => decodeTreasuryMock(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use Keypair.generate() so all pubkeys are guaranteed-valid 32-byte base58.
const TREASURY_VAULT = Keypair.generate().publicKey;
const HELIUS_POOL_VAULT = Keypair.generate().publicKey;
const BIRDEYE_POOL_VAULT = Keypair.generate().publicKey;
const JUPITER_POOL_VAULT = Keypair.generate().publicKey;
const HELIUS_AFFILIATE_ATA = Keypair.generate().publicKey;
const BIRDEYE_AFFILIATE_ATA = Keypair.generate().publicKey;

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const env: Record<string, string> = {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    ...overrides,
  };
  return {
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (env[k] === undefined) throw new Error(`missing ${k}`);
      return env[k];
    }),
    get: vi.fn().mockImplementation((k: string) => env[k]),
  } as unknown as ConfigService;
}

function makeMessage(opts: {
  callIdHex: string;
  agentPubkey: string;
  slug: string;
  premiumLamports?: string | bigint;
  refundLamports?: string | bigint;
  outcome?: string;
  latencyMs?: number;
}): SettleMessage {
  return {
    id: opts.callIdHex,
    data: {
      callId: opts.callIdHex,
      agentPubkey: opts.agentPubkey,
      endpointSlug: opts.slug,
      premiumLamports: String(opts.premiumLamports ?? "1000"),
      refundLamports: String(opts.refundLamports ?? "0"),
      latencyMs: opts.latencyMs ?? 80,
      outcome: opts.outcome ?? "ok",
      ts: new Date().toISOString(),
    },
    raw: { ack: vi.fn(), nack: vi.fn() } as unknown as import("@google-cloud/pubsub").Message,
  };
}

function fakeEndpointConfig(opts: {
  slug: string;
  feeRecipients: Array<{
    kind: FeeRecipientKind;
    destination: string;
    bps: number;
  }>;
}): EndpointConfig {
  return {
    bump: 254,
    paused: false,
    slug: new TextEncoder().encode(opts.slug.padEnd(16, "\0")).slice(0, 16),
    flatPremiumLamports: 1000n,
    percentBps: 0,
    slaLatencyMs: 200,
    imputedCostLamports: 5000n,
    exposureCapPerHourLamports: 1_000_000n,
    currentPeriodStart: 0n,
    currentPeriodRefunds: 0n,
    totalCalls: 0n,
    totalBreaches: 0n,
    totalPremiums: 0n,
    totalRefunds: 0n,
    lastUpdated: 0n,
    coveragePool: PublicKey.default.toBase58(),
    feeRecipientCount: opts.feeRecipients.length,
    feeRecipients: opts.feeRecipients,
  };
}

function fakePool(vault: PublicKey): CoveragePool {
  return {
    bump: 254,
    authority: PublicKey.default.toBase58(),
    usdcMint: PublicKey.default.toBase58(),
    usdcVault: vault.toBase58(),
    endpointSlug: new Uint8Array(16),
    totalDeposits: 0n,
    totalPremiums: 0n,
    totalRefunds: 0n,
    currentBalance: 1_000_000_000n,
    createdAt: 0n,
  };
}

function fakeTreasury(vault: PublicKey): Treasury {
  return {
    bump: 254,
    authority: PublicKey.default.toBase58(),
    usdcVault: vault.toBase58(),
    setAt: 0n,
  };
}

/**
 * Wire up getAccountInfo so each (slug -> EndpointConfig+pool) pair plus the
 * singleton Treasury return deterministic decoded values. The mocked decoders
 * just return whatever map entry matches the queried pubkey.
 */
function wireChainStubs(
  endpointsBySlug: Map<
    string,
    { config: EndpointConfig; pool: CoveragePool; epPda: PublicKey; poolPda: PublicKey }
  >,
  treasury: { pda: PublicKey; treasury: Treasury },
) {
  // Map data buffer -> decoded value. Use Buffer instances as keys via .toString.
  const decodeMap = new Map<string, EndpointConfig | CoveragePool | Treasury>();

  let counter = 0;
  function bufferFor(decoded: EndpointConfig | CoveragePool | Treasury): Buffer {
    const buf = Buffer.from(`mock-${++counter}`);
    decodeMap.set(buf.toString(), decoded);
    return buf;
  }

  const accountInfoByPubkey = new Map<string, { data: Buffer }>();
  for (const [, snap] of endpointsBySlug) {
    accountInfoByPubkey.set(snap.epPda.toBase58(), {
      data: bufferFor(snap.config),
    });
    accountInfoByPubkey.set(snap.poolPda.toBase58(), {
      data: bufferFor(snap.pool),
    });
  }
  accountInfoByPubkey.set(treasury.pda.toBase58(), {
    data: bufferFor(treasury.treasury),
  });

  getAccountInfoMock.mockImplementation(async (pubkey: PublicKey) => {
    return accountInfoByPubkey.get(pubkey.toBase58()) ?? null;
  });

  decodeEndpointConfigMock.mockImplementation((data: Buffer) => {
    const v = decodeMap.get(data.toString());
    if (!v || !("feeRecipientCount" in v)) {
      throw new Error("unexpected decodeEndpointConfig input");
    }
    return v;
  });
  decodeCoveragePoolMock.mockImplementation((data: Buffer) => {
    const v = decodeMap.get(data.toString());
    if (!v || !("currentBalance" in v)) {
      throw new Error("unexpected decodeCoveragePool input");
    }
    return v;
  });
  decodeTreasuryMock.mockImplementation((data: Buffer) => {
    const v = decodeMap.get(data.toString());
    if (!v || !("setAt" in v) || "currentBalance" in v) {
      throw new Error("unexpected decodeTreasury input");
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubmitterService", () => {
  let service: SubmitterService;
  let devKeypair: Keypair;
  // Recompute these from the actual program-id derivation so the test PDAs
  // line up with the service's internal derivation.
  let heliusEpPda: PublicKey;
  let heliusPoolPda: PublicKey;
  let birdeyeEpPda: PublicKey;
  let birdeyePoolPda: PublicKey;
  let jupiterEpPda: PublicKey;
  let jupiterPoolPda: PublicKey;
  let treasuryPda: PublicKey;

  beforeEach(async () => {
    sendAndConfirmMock.mockReset();
    getAccountInfoMock.mockReset();
    decodeEndpointConfigMock.mockReset();
    decodeCoveragePoolMock.mockReset();
    decodeTreasuryMock.mockReset();
    buildSettleBatchIxMock.mockReset();
    buildSettleBatchIxMock.mockImplementation(() => ({
      keys: [],
      programId: PublicKey.default,
      data: Buffer.from([10]),
    }));

    devKeypair = Keypair.generate();
    service = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
    );

    // Derive PDAs the way the service derives them so the stub map keys match.
    const programId = new PublicKey(
      "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    );
    const { getEndpointConfigPda, getCoveragePoolPda, getTreasuryPda, slugBytes } =
      await import("@pact-network/protocol-v1-client");
    [heliusEpPda] = getEndpointConfigPda(programId, slugBytes("helius"));
    [heliusPoolPda] = getCoveragePoolPda(programId, slugBytes("helius"));
    [birdeyeEpPda] = getEndpointConfigPda(programId, slugBytes("birdeye"));
    [birdeyePoolPda] = getCoveragePoolPda(programId, slugBytes("birdeye"));
    [jupiterEpPda] = getEndpointConfigPda(programId, slugBytes("jupiter"));
    [jupiterPoolPda] = getCoveragePoolPda(programId, slugBytes("jupiter"));
    [treasuryPda] = getTreasuryPda(programId);
  });

  it("returns signature on a single-event happy path with treasury fee", async () => {
    const heliusEp = fakeEndpointConfig({
      slug: "helius",
      feeRecipients: [
        {
          kind: FeeRecipientKind.Treasury,
          destination: TREASURY_VAULT.toBase58(),
          bps: 1000, // 10%
        },
      ],
    });
    wireChainStubs(
      new Map([
        [
          "helius",
          {
            config: heliusEp,
            pool: fakePool(HELIUS_POOL_VAULT),
            epPda: heliusEpPda,
            poolPda: heliusPoolPda,
          },
        ],
      ]),
      { pda: treasuryPda, treasury: fakeTreasury(TREASURY_VAULT) },
    );
    sendAndConfirmMock.mockResolvedValueOnce("sig_helius_ok");
    await service.onModuleInit();

    const batch: SettleBatch = {
      messages: [
        makeMessage({
          callIdHex: "00000000000000000000000000000001",
          agentPubkey: Keypair.generate().publicKey.toBase58(),
          slug: "helius",
          premiumLamports: "1000",
        }),
      ],
    };
    const outcome = await service.submit(batch);
    expect(outcome.signature).toBe("sig_helius_ok");
    expect(outcome.perEventShares).toHaveLength(1);
    expect(outcome.perEventShares[0]).toHaveLength(1);
    expect(outcome.perEventShares[0][0].kind).toBe(FeeRecipientKind.Treasury);
    expect(outcome.perEventShares[0][0].pubkey).toBe(TREASURY_VAULT.toBase58());
    // 1000 * 1000 / 10_000 = 100
    expect(outcome.perEventShares[0][0].amountLamports).toBe(100n);
    expect(buildSettleBatchIxMock).toHaveBeenCalledOnce();
  });

  it("builds per-event positional accounts (no cross-event dedup) for a mixed batch", async () => {
    const heliusEp = fakeEndpointConfig({
      slug: "helius",
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT.toBase58(), bps: 1000 },
        {
          kind: FeeRecipientKind.AffiliateAta,
          destination: HELIUS_AFFILIATE_ATA.toBase58(),
          bps: 500,
        },
      ],
    });
    const birdeyeEp = fakeEndpointConfig({
      slug: "birdeye",
      feeRecipients: [
        {
          kind: FeeRecipientKind.AffiliateAta,
          destination: BIRDEYE_AFFILIATE_ATA.toBase58(),
          bps: 300,
        },
      ],
    });
    const jupiterEp = fakeEndpointConfig({
      slug: "jupiter",
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT.toBase58(), bps: 2000 },
      ],
    });
    wireChainStubs(
      new Map([
        ["helius", { config: heliusEp, pool: fakePool(HELIUS_POOL_VAULT), epPda: heliusEpPda, poolPda: heliusPoolPda }],
        ["birdeye", { config: birdeyeEp, pool: fakePool(BIRDEYE_POOL_VAULT), epPda: birdeyeEpPda, poolPda: birdeyePoolPda }],
        ["jupiter", { config: jupiterEp, pool: fakePool(JUPITER_POOL_VAULT), epPda: jupiterEpPda, poolPda: jupiterPoolPda }],
      ]),
      { pda: treasuryPda, treasury: fakeTreasury(TREASURY_VAULT) },
    );
    sendAndConfirmMock.mockResolvedValueOnce("sig_mixed_ok");
    await service.onModuleInit();

    const agent = Keypair.generate().publicKey.toBase58();
    const batch: SettleBatch = {
      messages: [
        makeMessage({ callIdHex: "0000000000000000000000000000000a", agentPubkey: agent, slug: "helius", premiumLamports: "10000" }),
        makeMessage({ callIdHex: "0000000000000000000000000000000b", agentPubkey: agent, slug: "birdeye", premiumLamports: "10000" }),
        makeMessage({ callIdHex: "0000000000000000000000000000000c", agentPubkey: agent, slug: "helius", premiumLamports: "10000" }), // repeat slug
        makeMessage({ callIdHex: "0000000000000000000000000000000d", agentPubkey: agent, slug: "jupiter", premiumLamports: "10000" }),
      ],
    };
    const outcome = await service.submit(batch);
    expect(outcome.signature).toBe("sig_mixed_ok");

    // Inspect the events passed into buildSettleBatchIx.
    const args = buildSettleBatchIxMock.mock.calls[0][0] as {
      events: Array<{
        coveragePool: PublicKey;
        poolVault: PublicKey;
        feeRecipientAtas: PublicKey[];
      }>;
      callRecordPdas: PublicKey[];
    };
    expect(args.events).toHaveLength(4);

    // Per-event positional ordering — the helius event at index 2 must
    // re-emit its own pool/vault/ATAs even though helius already appeared at
    // index 0 (no dedup).
    expect(args.events[0].coveragePool.toBase58()).toBe(heliusPoolPda.toBase58());
    expect(args.events[0].poolVault.toBase58()).toBe(HELIUS_POOL_VAULT.toBase58());
    expect(args.events[0].feeRecipientAtas).toHaveLength(2);

    expect(args.events[2].coveragePool.toBase58()).toBe(heliusPoolPda.toBase58());
    expect(args.events[2].poolVault.toBase58()).toBe(HELIUS_POOL_VAULT.toBase58());
    expect(args.events[2].feeRecipientAtas).toHaveLength(2);
    // Both helius events must point at the same Treasury vault for slot 0.
    expect(args.events[0].feeRecipientAtas[0].toBase58()).toBe(TREASURY_VAULT.toBase58());
    expect(args.events[2].feeRecipientAtas[0].toBase58()).toBe(TREASURY_VAULT.toBase58());
    // ...and the same Affiliate for slot 1.
    expect(args.events[0].feeRecipientAtas[1].toBase58()).toBe(HELIUS_AFFILIATE_ATA.toBase58());

    // Birdeye event has 1 fee recipient (Affiliate only).
    expect(args.events[1].coveragePool.toBase58()).toBe(birdeyePoolPda.toBase58());
    expect(args.events[1].feeRecipientAtas).toHaveLength(1);
    expect(args.events[1].feeRecipientAtas[0].toBase58()).toBe(BIRDEYE_AFFILIATE_ATA.toBase58());

    // Jupiter event has 1 Treasury fee.
    expect(args.events[3].feeRecipientAtas).toHaveLength(1);
    expect(args.events[3].feeRecipientAtas[0].toBase58()).toBe(TREASURY_VAULT.toBase58());
  });

  it("appends Treasury vault for any event whose endpoint has Treasury kind", async () => {
    const heliusEp = fakeEndpointConfig({
      slug: "helius",
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT.toBase58(), bps: 1000 },
      ],
    });
    wireChainStubs(
      new Map([
        ["helius", { config: heliusEp, pool: fakePool(HELIUS_POOL_VAULT), epPda: heliusEpPda, poolPda: heliusPoolPda }],
      ]),
      { pda: treasuryPda, treasury: fakeTreasury(TREASURY_VAULT) },
    );
    sendAndConfirmMock.mockResolvedValueOnce("sig_treasury");
    await service.onModuleInit();

    const batch: SettleBatch = {
      messages: [
        makeMessage({
          callIdHex: "00000000000000000000000000000099",
          agentPubkey: Keypair.generate().publicKey.toBase58(),
          slug: "helius",
        }),
      ],
    };
    const outcome = await service.submit(batch);
    expect(outcome.perEventShares[0][0].pubkey).toBe(TREASURY_VAULT.toBase58());
  });

  it("retries on transient send failure and succeeds on second attempt", async () => {
    const heliusEp = fakeEndpointConfig({
      slug: "helius",
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT.toBase58(), bps: 1000 },
      ],
    });
    wireChainStubs(
      new Map([
        ["helius", { config: heliusEp, pool: fakePool(HELIUS_POOL_VAULT), epPda: heliusEpPda, poolPda: heliusPoolPda }],
      ]),
      { pda: treasuryPda, treasury: fakeTreasury(TREASURY_VAULT) },
    );
    sendAndConfirmMock
      .mockRejectedValueOnce(new Error("blockhash expired"))
      .mockResolvedValueOnce("sig_retry_ok");
    await service.onModuleInit();

    const batch: SettleBatch = {
      messages: [
        makeMessage({
          callIdHex: "00000000000000000000000000000033",
          agentPubkey: Keypair.generate().publicKey.toBase58(),
          slug: "helius",
        }),
      ],
    };
    const outcome = await service.submit(batch);
    expect(outcome.signature).toBe("sig_retry_ok");
    expect(sendAndConfirmMock).toHaveBeenCalledTimes(2);
  });

  it("throws BatchSubmitError after 3 consecutive failures", async () => {
    const heliusEp = fakeEndpointConfig({
      slug: "helius",
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT.toBase58(), bps: 1000 },
      ],
    });
    wireChainStubs(
      new Map([
        ["helius", { config: heliusEp, pool: fakePool(HELIUS_POOL_VAULT), epPda: heliusEpPda, poolPda: heliusPoolPda }],
      ]),
      { pda: treasuryPda, treasury: fakeTreasury(TREASURY_VAULT) },
    );
    sendAndConfirmMock.mockRejectedValue(new Error("rpc down"));
    await service.onModuleInit();

    const batch: SettleBatch = {
      messages: [
        makeMessage({
          callIdHex: "00000000000000000000000000000077",
          agentPubkey: Keypair.generate().publicKey.toBase58(),
          slug: "helius",
        }),
      ],
    };
    await expect(service.submit(batch)).rejects.toThrow(BatchSubmitError);
    expect(sendAndConfirmMock).toHaveBeenCalledTimes(3);
  });

  it("works without POOL_VAULT_PUBKEY env — per-endpoint pool resolved from slug", async () => {
    const heliusEp = fakeEndpointConfig({
      slug: "helius",
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT.toBase58(), bps: 1000 },
      ],
    });
    wireChainStubs(
      new Map([
        ["helius", { config: heliusEp, pool: fakePool(HELIUS_POOL_VAULT), epPda: heliusEpPda, poolPda: heliusPoolPda }],
      ]),
      { pda: treasuryPda, treasury: fakeTreasury(TREASURY_VAULT) },
    );
    sendAndConfirmMock.mockResolvedValueOnce("sig_no_env");
    await service.onModuleInit();

    // Note: makeConfig() never sets POOL_VAULT_PUBKEY.
    const batch: SettleBatch = {
      messages: [
        makeMessage({
          callIdHex: "00000000000000000000000000000055",
          agentPubkey: Keypair.generate().publicKey.toBase58(),
          slug: "helius",
        }),
      ],
    };
    const outcome = await service.submit(batch);
    expect(outcome.signature).toBe("sig_no_env");

    const args = buildSettleBatchIxMock.mock.calls[0][0] as {
      events: Array<{ coveragePool: PublicKey; poolVault: PublicKey }>;
    };
    // Pool vault came from on-chain CoveragePool, not env.
    expect(args.events[0].poolVault.toBase58()).toBe(HELIUS_POOL_VAULT.toBase58());
    expect(args.events[0].coveragePool.toBase58()).toBe(heliusPoolPda.toBase58());
  });
});
