/**
 * arc-testnet-routing.spec.ts — WP-MN-04 T5
 *
 * Asserts that SubmitterService routes a batch with `network: 'arc-testnet'`
 * to the EVM adapter (NOT the SolanaAdapter or the legacy direct path) and
 * skips the Solana keypair lookup (which would throw for EVM networks per
 * the loadKeypair contract).
 *
 * Scope: routing-dispatch unit. We mock the AdaptersService surface entirely
 * (no real EvmAdapter, no viem, no RPC). The contract under test is the
 * branching logic in SubmitterService.submit + submitViaAdapter:
 *
 *   1. solana-* batch + legacyDirectSolana=true  → submitLegacyDirect (existing)
 *   2. solana-* batch + legacyDirectSolana=false → adapter via getSigner (existing)
 *   3. arc-testnet batch                         → adapter via NO getSigner (NEW)
 *
 * The WP-MN-03b GATE B headline (adapter-swap-e2e.spec.ts) already proved
 * byte-identical perEventShares for the Solana path. This test proves the
 * arc-testnet entry plugs into the same plumbing without invoking the Solana
 * signer code (which would throw for EVM).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  FeeRecipientKind,
  type EndpointConfig,
  type CoveragePool,
  type Treasury,
} from "@pact-network/protocol-v1-client";
import { SubmitterService } from "../src/submitter/submitter.service.js";
import type { AdaptersService } from "../src/adapters/adapters.service.js";
import type { ConfigService } from "@nestjs/config";
import type { SecretLoaderService } from "../src/config/secret-loader.service.js";
import type { SettleBatch } from "../src/batcher/batcher.service.js";

// ---------------------------------------------------------------------------
// Stub chain modules — getAccountInfo returns deterministic EndpointConfig +
// CoveragePool + Treasury. Mirrors adapter-swap-e2e.spec.ts so loadEndpoint()
// resolves cleanly (the adapter path still calls loadEndpoint off-chain to
// compute perEventShares).
// ---------------------------------------------------------------------------

const getAccountInfoMock = vi.fn();

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: getAccountInfoMock,
    })),
  };
});

const decodeEndpointConfigMock = vi.fn();
const decodeCoveragePoolMock = vi.fn();
const decodeTreasuryMock = vi.fn();

vi.mock("@pact-network/protocol-v1-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pact-network/protocol-v1-client")>();
  return {
    ...actual,
    decodeEndpointConfig: (...args: unknown[]) => decodeEndpointConfigMock(...args),
    decodeCoveragePool: (...args: unknown[]) => decodeCoveragePoolMock(...args),
    decodeTreasury: (...args: unknown[]) => decodeTreasuryMock(...args),
    findCoveragePoolPda: vi.fn(() => [PublicKey.default, 0]),
    findEndpointConfigPda: vi.fn(() => [PublicKey.default, 0]),
    findTreasuryPda: vi.fn(() => [PublicKey.default, 0]),
    findCallRecordPda: vi.fn(() => [PublicKey.default, 0]),
    findSettlementAuthorityPda: vi.fn(() => [PublicKey.default, 0]),
    findProtocolConfigPda: vi.fn(() => [PublicKey.default, 0]),
  };
});

// ---------------------------------------------------------------------------
// Fixture chain accounts
// ---------------------------------------------------------------------------

const TREASURY_VAULT = new PublicKey("2fRwQP7AFEdUANMc8SknQzeFUHNzsNTb2A3VNWo67tP1");
const HELIUS_AFFILIATE_ATA = new PublicKey("ELfAtarMzqGZ7BzYhwsiNkPbDh5Mqkr5jGSC4mxnZdvi");
const SLUG_BYTES = Buffer.from("helius".padEnd(16, "\0"));

const ENDPOINT_CONFIG: EndpointConfig = {
  authority: PublicKey.default,
  slug: SLUG_BYTES,
  upstreamBase: "",
  flatPremium: 0n,
  percentBps: 0,
  slaLatencyMs: 0,
  imputedCost: 0n,
  exposureCapPerHour: 0n,
  paused: false,
  feeRecipients: [
    { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT, bps: 1000 },
    { kind: FeeRecipientKind.AffiliateAta, destination: HELIUS_AFFILIATE_ATA, bps: 500 },
  ],
  feeRecipientCount: 2,
  totalCalls: 0n,
  totalBreaches: 0n,
  totalPremiums: 0n,
  totalRefunds: 0n,
  currentPeriodStart: 0n,
  currentPeriodRefunds: 0n,
  lastUpdated: 0n,
} as unknown as EndpointConfig;

const COVERAGE_POOL: CoveragePool = {
  bump: 0,
  authority: PublicKey.default,
  usdcMint: PublicKey.default,
  usdcVault: PublicKey.default,
  endpointSlug: new Uint8Array(SLUG_BYTES),
  totalDeposits: 0n,
  totalPremiums: 0n,
  totalRefunds: 0n,
} as unknown as CoveragePool;

const TREASURY: Treasury = {
  bump: 0,
  authority: PublicKey.default,
  usdcVault: TREASURY_VAULT,
  setAt: 0n,
} as unknown as Treasury;

// ---------------------------------------------------------------------------
// Helpers — copy-paste pattern from adapter-swap-e2e.spec.ts
// ---------------------------------------------------------------------------

function wireStubs() {
  const someBuffer = { data: Buffer.from([1, 2, 3]) };
  getAccountInfoMock.mockResolvedValue(someBuffer);
  decodeEndpointConfigMock.mockReturnValue(ENDPOINT_CONFIG);
  decodeCoveragePoolMock.mockReturnValue(COVERAGE_POOL);
  decodeTreasuryMock.mockReturnValue(TREASURY);
}

function makeConfig(extra: Record<string, string> = {}): ConfigService {
  const env: Record<string, string> = {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    ...extra,
  };
  return {
    get: vi.fn().mockImplementation((k: string) => env[k]),
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (env[k] === undefined) throw new Error(`missing ${k}`);
      return env[k];
    }),
  } as unknown as ConfigService;
}

function makeArcMessage(callIdHex: string, premiumLamports: bigint) {
  return {
    id: callIdHex,
    ackId: callIdHex,
    publishTime: new Date(),
    data: {
      callId: callIdHex,
      network: "arc-testnet",
      agentPubkey: "0xAgent0000000000000000000000000000000001",
      endpointSlug: "helius",
      premiumLamports: premiumLamports.toString(),
      refundLamports: "0",
      latencyMs: 100,
      outcome: "ok",
      ts: new Date().toISOString(),
      signature: "stub",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WP-MN-04 T5 — arc-testnet routing dispatch", () => {
  let devKeypair: Keypair;
  const ARC_STUB_TX = "0xArcStubTxHash000000000000000000000000000000000000000000000000arc1";

  beforeEach(() => {
    getAccountInfoMock.mockReset();
    decodeEndpointConfigMock.mockReset();
    decodeCoveragePoolMock.mockReset();
    decodeTreasuryMock.mockReset();
    devKeypair = Keypair.generate();
  });

  it("network='arc-testnet' routes to EvmAdapter and SKIPS Solana getSigner lookup", async () => {
    wireStubs();

    // Stub EVM adapter — descriptor.vm = "evm" is the routing key.
    const evmAdapter = {
      descriptor: { vm: "evm" as const },
      submitSettleBatch: vi.fn().mockResolvedValue({ txId: ARC_STUB_TX }),
      checkAgentEligibility: vi.fn(),
      readEndpointConfigs: vi.fn(),
      // Finding 1 (mn-04 fix-WP T1): the EVM submit path now derives fee
      // fan-out via the adapter's getEndpoint() instead of Solana PDAs.
      getEndpoint: vi.fn().mockResolvedValue({
        slug: "helius",
        authority: "",
        maxTotalFeeBps: 0,
        feeRecipients: [],
        paused: false,
        raw: {},
      }),
    };

    // AdaptersService stub — getSigner THROWS to prove submitViaAdapter does not
    // call it for EVM networks (the bug T5 surfaces from the WP-MN-03b code).
    const getSignerMock = vi.fn(() => {
      throw new Error("getSigner must not be called for EVM networks");
    });
    const stubAdaptersArc = {
      legacyDirectSolana: false,
      getAdapter: vi.fn().mockReturnValue(evmAdapter),
      getSigner: getSignerMock,
    } as unknown as AdaptersService;

    const batch: SettleBatch = {
      messages: [makeArcMessage("00000000000000000000000000000001", 2000n)],
    };

    const service = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
      stubAdaptersArc,
    );
    await service.onModuleInit();
    const outcome = await service.submit(batch);

    // 1. EvmAdapter was invoked with the batch.
    expect(evmAdapter.submitSettleBatch).toHaveBeenCalledOnce();
    // 2. Solana getSigner was NOT called (bug fix gate).
    expect(getSignerMock).not.toHaveBeenCalled();
    // 3. SettleBatchInput.signer was null (EVM convention — signer is in the
    //    adapter's WalletClient, not the input).
    expect(evmAdapter.submitSettleBatch.mock.calls[0][0].signer).toBeNull();
    // 4. The EVM tx hash flows through to SettlementOutcome.
    expect(outcome.signature).toBe(ARC_STUB_TX);
  });

  it("network='arc-testnet' is unaffected by legacyDirectSolana=true (flag is solana-only)", async () => {
    wireStubs();

    const evmAdapter = {
      descriptor: { vm: "evm" as const },
      submitSettleBatch: vi.fn().mockResolvedValue({ txId: ARC_STUB_TX }),
      checkAgentEligibility: vi.fn(),
      readEndpointConfigs: vi.fn(),
      // Finding 1 (mn-04 fix-WP T1): the EVM submit path now derives fee
      // fan-out via the adapter's getEndpoint() instead of Solana PDAs.
      getEndpoint: vi.fn().mockResolvedValue({
        slug: "helius",
        authority: "",
        maxTotalFeeBps: 0,
        feeRecipients: [],
        paused: false,
        raw: {},
      }),
    };

    // Even with legacyDirectSolana=true, an arc-testnet batch must use the
    // adapter path — the flag only short-circuits networks starting with
    // "solana-" per submit() line 181.
    const stubAdaptersArc = {
      legacyDirectSolana: true,
      getAdapter: vi.fn().mockReturnValue(evmAdapter),
      getSigner: vi.fn(),
    } as unknown as AdaptersService;

    const batch: SettleBatch = {
      messages: [makeArcMessage("00000000000000000000000000000002", 5000n)],
    };

    const service = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
      stubAdaptersArc,
    );
    await service.onModuleInit();
    const outcome = await service.submit(batch);

    // Adapter path used; legacy-direct path bypassed.
    expect(evmAdapter.submitSettleBatch).toHaveBeenCalledOnce();
    expect(outcome.signature).toBe(ARC_STUB_TX);
  });

  it("network='solana-devnet' STILL uses getSigner (Solana routing unchanged)", async () => {
    wireStubs();

    const solanaAdapter = {
      descriptor: { vm: "solana" as const },
      submitSettleBatch: vi.fn().mockResolvedValue({
        txId: "SolanaStubSigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
      checkAgentEligibility: vi.fn(),
      readEndpointConfigs: vi.fn(),
    };
    const getSignerMock = vi.fn().mockReturnValue(Keypair.generate());
    const stubAdaptersSol = {
      legacyDirectSolana: false,
      getAdapter: vi.fn().mockReturnValue(solanaAdapter),
      getSigner: getSignerMock,
    } as unknown as AdaptersService;

    const solanaMsg = makeArcMessage("00000000000000000000000000000003", 1000n);
    (solanaMsg.data as Record<string, unknown>).network = "solana-devnet";
    const batch: SettleBatch = { messages: [solanaMsg] };

    const service = new SubmitterService(
      makeConfig(),
      { keypair: devKeypair } as unknown as SecretLoaderService,
      stubAdaptersSol,
    );
    await service.onModuleInit();
    await service.submit(batch);

    // Regression guard: Solana path STILL calls getSigner and passes the
    // Keypair through to SettleBatchInput.signer.
    expect(getSignerMock).toHaveBeenCalledOnce();
    expect(solanaAdapter.submitSettleBatch).toHaveBeenCalledOnce();
    const signerArg = solanaAdapter.submitSettleBatch.mock.calls[0][0].signer;
    expect(signerArg).not.toBeNull();
    expect(signerArg.publicKey).toBeDefined();
  });
});
