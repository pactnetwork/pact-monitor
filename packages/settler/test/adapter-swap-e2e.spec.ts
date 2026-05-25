/**
 * adapter-swap-e2e.spec.ts — WP-MN-03b T5 (THE GATE B HEADLINE ARTIFACT)
 *
 * Asserts that computeFeeSharesForEvent produces byte-identical RecipientShare
 * arrays from BOTH the legacy-direct path (submitLegacyDirect) and the
 * adapter path (submitViaAdapter) for the same fixture batch.
 *
 * Scope: unit-level share computation. The on-chain signature comes from the
 * StubConnection / StubAdapter (both return a deterministic txId). The critical
 * assertion is that perEventShares are equal between paths — this proves the
 * indexer will receive the same fee-recipient rows regardless of which path
 * processes the batch.
 *
 * How to read this test:
 *  - We build SubmitterService twice: once with legacyDirectSolana=true (legacy
 *    path) and once with legacyDirectSolana=false (adapter path).
 *  - Both share the same stubbed Connection (getAccountInfo returns deterministic
 *    EndpointConfig + CoveragePool + Treasury).
 *  - The adapter stub returns a deterministic txId and bypasses all on-chain
 *    work — it does NOT do a real submitSettleBatch on-chain.
 *  - We assert perEventShares arrays are deeply equal between both runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { FeeRecipientKind, type EndpointConfig, type CoveragePool, type Treasury } from "@q3labs/pact-protocol-v1-client";
import { SubmitterService } from "../src/submitter/submitter.service.js";
import type { AdaptersService } from "../src/adapters/adapters.service.js";
import type { ConfigService } from "@nestjs/config";
import type { SecretLoaderService } from "../src/config/secret-loader.service.js";
import type { SettleBatch } from "../src/batcher/batcher.service.js";

// ---------------------------------------------------------------------------
// Shared chain stubs (same as submitter.service.spec.ts pattern)
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

const decodeEndpointConfigMock = vi.fn();
const decodeCoveragePoolMock = vi.fn();
const decodeTreasuryMock = vi.fn();
const buildSettleBatchIxMock = vi.fn();

vi.mock("@q3labs/pact-protocol-v1-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@q3labs/pact-protocol-v1-client")>();
  return {
    ...actual,
    buildSettleBatchIx: (...args: unknown[]) => buildSettleBatchIxMock(...args),
    decodeEndpointConfig: (...args: unknown[]) => decodeEndpointConfigMock(...args),
    decodeCoveragePool: (...args: unknown[]) => decodeCoveragePoolMock(...args),
    decodeTreasury: (...args: unknown[]) => decodeTreasuryMock(...args),
  };
});

// ---------------------------------------------------------------------------
// Fixtures (deterministic pubkeys so share.pubkey fields are stable)
// ---------------------------------------------------------------------------

const TREASURY_VAULT = Keypair.generate().publicKey;
const HELIUS_POOL_VAULT = Keypair.generate().publicKey;
const HELIUS_AFFILIATE_ATA = Keypair.generate().publicKey;
const AGENT_PUBKEY = Keypair.generate().publicKey.toBase58();

const FIXTURE_ENDPOINT_CONFIG: EndpointConfig = {
  bump: 254,
  paused: false,
  slug: new TextEncoder().encode("helius\0\0\0\0\0\0\0\0\0\0").slice(0, 16),
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
  feeRecipientCount: 2,
  feeRecipients: [
    {
      kind: FeeRecipientKind.Treasury,
      destination: TREASURY_VAULT.toBase58(),
      bps: 1000, // 10%
    },
    {
      kind: FeeRecipientKind.AffiliateAta,
      destination: HELIUS_AFFILIATE_ATA.toBase58(),
      bps: 500, // 5%
    },
  ],
};

const FIXTURE_POOL: CoveragePool = {
  bump: 254,
  authority: PublicKey.default.toBase58(),
  usdcMint: PublicKey.default.toBase58(),
  usdcVault: HELIUS_POOL_VAULT.toBase58(),
  endpointSlug: new Uint8Array(16),
  totalDeposits: 0n,
  totalPremiums: 0n,
  totalRefunds: 0n,
  currentBalance: 1_000_000_000n,
  createdAt: 0n,
};

const FIXTURE_TREASURY: Treasury = {
  bump: 254,
  authority: PublicKey.default.toBase58(),
  usdcVault: TREASURY_VAULT.toBase58(),
  setAt: 0n,
};

// Fixed premiums for the two messages.
const PREMIUM_A = 2000n; // 2000 lamports
const PREMIUM_B = 5000n; // 5000 lamports

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): ConfigService {
  const env: Record<string, string> = {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  };
  return {
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (env[k] === undefined) throw new Error(`missing ${k}`);
      return env[k];
    }),
    get: vi.fn().mockImplementation((k: string) => env[k]),
  } as unknown as ConfigService;
}

function makeMessage(callIdHex: string, premiumLamports: bigint): import("../src/consumer/consumer.service.js").SettleMessage {
  return {
    id: callIdHex,
    data: {
      callId: callIdHex,
      agentPubkey: AGENT_PUBKEY,
      endpointSlug: "helius",
      premiumLamports: String(premiumLamports),
      refundLamports: "0",
      latencyMs: 50,
      outcome: "ok",
      ts: new Date().toISOString(),
      network: "solana-devnet",
    },
    raw: { ack: vi.fn(), nack: vi.fn() } as unknown as import("@google-cloud/pubsub").Message,
  };
}

/**
 * Wire getAccountInfo stubs for the helius endpoint + treasury.
 * Mirrors the wireChainStubs pattern from submitter.service.spec.ts.
 */
async function wireStubs(): Promise<{
  heliusEpPda: PublicKey;
  heliusPoolPda: PublicKey;
  treasuryPda: PublicKey;
}> {
  const programId = new PublicKey("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5");
  const { getEndpointConfigPda, getCoveragePoolPda, getTreasuryPda, slugBytes } =
    await import("@q3labs/pact-protocol-v1-client");
  const [heliusEpPda] = getEndpointConfigPda(programId, slugBytes("helius"));
  const [heliusPoolPda] = getCoveragePoolPda(programId, slugBytes("helius"));
  const [treasuryPda] = getTreasuryPda(programId);

  const decodeMap = new Map<string, EndpointConfig | CoveragePool | Treasury>();
  let counter = 0;
  function bufferFor(decoded: EndpointConfig | CoveragePool | Treasury): Buffer {
    const buf = Buffer.from(`gate-b-mock-${++counter}`);
    decodeMap.set(buf.toString(), decoded);
    return buf;
  }

  const accountInfoByPubkey = new Map<string, { data: Buffer }>();
  accountInfoByPubkey.set(heliusEpPda.toBase58(), { data: bufferFor(FIXTURE_ENDPOINT_CONFIG) });
  accountInfoByPubkey.set(heliusPoolPda.toBase58(), { data: bufferFor(FIXTURE_POOL) });
  accountInfoByPubkey.set(treasuryPda.toBase58(), { data: bufferFor(FIXTURE_TREASURY) });

  getAccountInfoMock.mockImplementation(async (pubkey: PublicKey) => {
    return accountInfoByPubkey.get(pubkey.toBase58()) ?? null;
  });
  decodeEndpointConfigMock.mockImplementation((data: Buffer) => {
    const v = decodeMap.get(data.toString());
    if (!v || !("feeRecipientCount" in v)) throw new Error("unexpected decodeEndpointConfig");
    return v;
  });
  decodeCoveragePoolMock.mockImplementation((data: Buffer) => {
    const v = decodeMap.get(data.toString());
    if (!v || !("currentBalance" in v)) throw new Error("unexpected decodeCoveragePool");
    return v;
  });
  decodeTreasuryMock.mockImplementation((data: Buffer) => {
    const v = decodeMap.get(data.toString());
    if (!v || !("setAt" in v) || "currentBalance" in v) throw new Error("unexpected decodeTreasury");
    return v;
  });

  return { heliusEpPda, heliusPoolPda, treasuryPda };
}

// Stub adapter that bypasses all on-chain work. Returns a deterministic txId.
const STUB_TX_ID = "GATEBstubSignatureAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const stubAdapter = {
  descriptor: { vm: "solana" as const },
  submitSettleBatch: vi.fn().mockResolvedValue({ txId: STUB_TX_ID }),
  checkAgentEligibility: vi.fn(),
  readEndpointConfigs: vi.fn(),
};
const stubAdaptersSolana = {
  legacyDirectSolana: false,
  getAdapter: vi.fn().mockReturnValue(stubAdapter),
  getSigner: vi.fn().mockReturnValue(Keypair.generate()),
} as unknown as AdaptersService;

const stubAdaptersLegacy = {
  legacyDirectSolana: true,
} as unknown as AdaptersService;

// ---------------------------------------------------------------------------
// Tests — THE GATE B
// ---------------------------------------------------------------------------

describe("WP-MN-03b — adapter-swap byte-identical (GATE B)", () => {
  let devKeypair: Keypair;

  beforeEach(() => {
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
    sendAndConfirmMock.mockResolvedValue("legacy-sig-AAAAAAA");
    stubAdapter.submitSettleBatch.mockResolvedValue({ txId: STUB_TX_ID });

    devKeypair = Keypair.generate();
  });

  it("computeFeeSharesForEvent: legacy path perEventShares === adapter path perEventShares (2-message batch)", async () => {
    await wireStubs();

    const batch: SettleBatch = {
      messages: [
        makeMessage("00000000000000000000000000000001", PREMIUM_A),
        makeMessage("00000000000000000000000000000002", PREMIUM_B),
      ],
    };

    // --- Legacy path ---
    const legacyService = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
      stubAdaptersLegacy,
    );
    await legacyService.onModuleInit();
    const legacyOutcome = await legacyService.submit(batch);

    // --- Adapter path ---
    const adapterService = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
      stubAdaptersSolana,
    );
    await adapterService.onModuleInit();
    const adapterOutcome = await adapterService.submit(batch);

    // GATE: perEventShares must be deeply equal between both paths.
    expect(adapterOutcome.perEventShares).toEqual(legacyOutcome.perEventShares);

    // Sanity: 2 events, 2 recipients each.
    expect(legacyOutcome.perEventShares).toHaveLength(2);
    expect(legacyOutcome.perEventShares[0]).toHaveLength(2);
    expect(legacyOutcome.perEventShares[1]).toHaveLength(2);

    // Verify on-chain math for message A (premium=2000):
    //   Treasury:  2000 * 1000 / 10_000 = 200
    //   Affiliate: 2000 *  500 / 10_000 = 100
    expect(legacyOutcome.perEventShares[0][0].kind).toBe(FeeRecipientKind.Treasury);
    expect(legacyOutcome.perEventShares[0][0].pubkey).toBe(TREASURY_VAULT.toBase58());
    expect(legacyOutcome.perEventShares[0][0].amountLamports).toBe(200n);

    expect(legacyOutcome.perEventShares[0][1].kind).toBe(FeeRecipientKind.AffiliateAta);
    expect(legacyOutcome.perEventShares[0][1].pubkey).toBe(HELIUS_AFFILIATE_ATA.toBase58());
    expect(legacyOutcome.perEventShares[0][1].amountLamports).toBe(100n);

    // Verify on-chain math for message B (premium=5000):
    //   Treasury:  5000 * 1000 / 10_000 = 500
    //   Affiliate: 5000 *  500 / 10_000 = 250
    expect(legacyOutcome.perEventShares[1][0].amountLamports).toBe(500n);
    expect(legacyOutcome.perEventShares[1][1].amountLamports).toBe(250n);
  });

  it("adapter path returns non-empty perEventShares (was empty[] in T4)", async () => {
    await wireStubs();

    const batch: SettleBatch = {
      messages: [
        makeMessage("00000000000000000000000000000010", PREMIUM_A),
      ],
    };

    const adapterService = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
      stubAdaptersSolana,
    );
    await adapterService.onModuleInit();
    const outcome = await adapterService.submit(batch);

    // T4 bug: this was [[]]. T5 fix: must be [[...real shares...]].
    expect(outcome.perEventShares).toHaveLength(1);
    expect(outcome.perEventShares[0].length).toBeGreaterThan(0);
    expect(outcome.perEventShares[0][0].amountLamports).toBeGreaterThan(0n);
  });

  it("adapter path stub signature flows through to SettlementOutcome", async () => {
    await wireStubs();

    const batch: SettleBatch = {
      messages: [
        makeMessage("00000000000000000000000000000020", PREMIUM_A),
      ],
    };

    const adapterService = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
      stubAdaptersSolana,
    );
    await adapterService.onModuleInit();
    const outcome = await adapterService.submit(batch);

    expect(outcome.signature).toBe(STUB_TX_ID);
  });
});
