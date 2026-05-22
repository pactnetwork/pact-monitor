/**
 * arc-testnet-settle-e2e.spec.ts — MN-04 fix-WP Task 0 (THE ACCEPTANCE GATE)
 *
 * This is the failing acceptance test that the whole MN-04 settle-path fix-WP
 * must turn GREEN. It exists because the previous EVM tests
 * (arc-testnet-routing.spec.ts, evm-adapter-unit.test.ts) STUBBED the seam:
 * one replaced the adapter's batch-submit method entirely, the other
 * hand-fed a pre-formatted 0x call id — so neither ever crossed the real
 * settler -> adapter -> calldata-encode -> indexer path with real data. Six
 * production bugs shipped through that gap (Rick's PR #225 review).
 *
 * Design rule for this file (do not relax it):
 *   - WIRE THE REAL components: the real SubmitterService, the real
 *     AdaptersService (which builds the real EvmAdapter), the real
 *     protocol-evm-v1-client calldata encoder, the real IndexerPusherService,
 *     the real indexer EventsService, and the real proxy auth middleware.
 *   - SUBSTITUTE ONLY network egress + storage: the viem JSON-RPC transport
 *     (so eth_call / eth_sendRawTransaction never hit Arc Testnet) and the
 *     Postgres client (an in-memory fake — NEVER a real/production DB). The
 *     Solana RPC Connection + Solana account decoders are likewise faked
 *     egress (they are NOT the EVM seam under test).
 *   - NOTHING in this file replaces the adapter's batch-submit method or the
 *     calldata encoder. The whole point is that the failure trace passes
 *     THROUGH the real encoder.
 *
 * Acceptance bar (Rick's merge gate), asserted below for an arc-testnet batch
 * built from a real UUID call id and an Ethereum 0x agent address:
 *   1. EVM auth path accepts a 0x / secp256k1 (EIP-191) agent — not Ed25519.
 *   2. ERC-20 balance/allowance is read via the EVM adapter (eth_call), not
 *      Solana PDAs.
 *   3. submit() reaches the real calldata encoder with a 0x-prefixed bytes16
 *      call id derived from the real UUID; calldata decodes to settleBatch.
 *   4. A breach with refundLamports encodes that exact refund value, NOT the
 *      premium.
 *   5. The indexer writes Settlement / endpoint-FK / PoolState / recipient-
 *      share rows ALL under network='arc-testnet' (zero defaulted to
 *      solana-devnet).
 *   6. A mixed-network / mixed-slug pending set partitions into single-network,
 *      single-slug batches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  decodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PactSettlerAbi } from "@pact-network/protocol-evm-v1-client";
import { FeeRecipientKind } from "@pact-network/protocol-v1-client";

import { AdaptersService } from "../src/adapters/adapters.service.js";
import {
  SubmitterService,
  type SettlementOutcome,
} from "../src/submitter/submitter.service.js";
import { BatcherService, type SettleBatch } from "../src/batcher/batcher.service.js";
import { IndexerPusherService } from "../src/indexer/indexer-pusher.service.js";
import type { ConfigService } from "@nestjs/config";
import type { SecretLoaderService } from "../src/config/secret-loader.service.js";
import type { SettleMessage } from "../src/consumer/consumer.service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRAM_ID = "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const FAKE_TX_HASH = ("0x" + "ab".repeat(32)) as Hex;

// A real secp256k1 keypair for the EVM agent + settler signer.
const ARC_SETTLER_PRIVKEY = generatePrivateKey();
const AGENT_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const AGENT_0X = AGENT_ACCOUNT.address; // checksummed 0x address

// ---------------------------------------------------------------------------
// Fake viem JSON-RPC transport (the ONLY EVM-side substitution).
//
// We substitute at the real network boundary: viem's real `http` transport
// POSTs JSON-RPC over `fetch`, so we stub `fetch` and answer a minimal set of
// JSON-RPC methods. viem itself — createPublicClient / createWalletClient /
// http / encodeFunctionData — stays 100% REAL, so the EvmAdapter's real
// calldata encoding runs and we capture the bytes it would broadcast. (Mocking
// the `viem` module instead does not work here: @pact-network/shared resolves
// its own viem copy, so a module mock would not intercept the adapter.)
// ---------------------------------------------------------------------------

interface RpcCall {
  method: string;
  params: unknown[];
}
let evmCalls: RpcCall[] = [];
let capturedCalldata: Hex | null = null;
let fakeBalance = 0n;
let fakeAllowance = 0n;

/** Encode a Multicall3 aggregate3 return: (bool success, bytes returnData)[]. */
function encodeMulticallResult(values: bigint[]): Hex {
  const results = values.map((v) => ({
    success: true,
    returnData: encodeAbiParameters(parseAbiParameters("uint256"), [v]),
  }));
  return encodeAbiParameters(
    parseAbiParameters("(bool success, bytes returnData)[]"),
    [results],
  );
}

function toHexQty(n: bigint): Hex {
  return ("0x" + n.toString(16)) as Hex;
}

async function fakeEvmRequest(args: {
  method: string;
  params?: unknown[];
}): Promise<unknown> {
  const { method, params = [] } = args;
  evmCalls.push({ method, params });
  switch (method) {
    case "eth_chainId":
      return toHexQty(5042002n);
    case "eth_blockNumber":
      return toHexQty(1000n);
    case "eth_getBlockByNumber":
      return {
        number: toHexQty(1000n),
        baseFeePerGas: toHexQty(1n),
        timestamp: toHexQty(1n),
      };
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return toHexQty(1n);
    case "eth_feeHistory":
      return {
        baseFeePerGas: [toHexQty(1n), toHexQty(1n)],
        gasUsedRatio: [0],
        oldestBlock: toHexQty(1n),
        reward: [[toHexQty(1n)]],
      };
    case "eth_estimateGas": {
      const tx = (params[0] ?? {}) as { data?: Hex };
      if (tx.data) capturedCalldata = tx.data;
      return toHexQty(21000n);
    }
    case "eth_call": {
      const tx = (params[0] ?? {}) as { to?: string; data?: Hex };
      if (tx.data) capturedCalldata = tx.data;
      if ((tx.to ?? "").toLowerCase() === MULTICALL3.toLowerCase()) {
        return encodeMulticallResult([fakeBalance, fakeAllowance]);
      }
      return "0x";
    }
    case "eth_sendRawTransaction":
      return FAKE_TX_HASH;
    case "eth_getTransactionReceipt":
      return {
        status: "0x1",
        blockNumber: toHexQty(1000n),
        transactionHash: FAKE_TX_HASH,
      };
    default:
      return "0x";
  }
}

/** Stub `fetch` to answer viem's JSON-RPC POSTs via fakeEvmRequest. */
async function fakeFetch(_input: unknown, init?: { body?: unknown }): Promise<Response> {
  const bodyText = typeof init?.body === "string" ? init.body : "";
  const payload = JSON.parse(bodyText) as
    | { id: number; method: string; params?: unknown[] }
    | Array<{ id: number; method: string; params?: unknown[] }>;
  const handleOne = async (req: { id: number; method: string; params?: unknown[] }) => ({
    jsonrpc: "2.0",
    id: req.id,
    result: await fakeEvmRequest({ method: req.method, params: req.params }),
  });
  const result = Array.isArray(payload)
    ? await Promise.all(payload.map(handleOne))
    : await handleOne(payload);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Fake Solana egress (Connection + account decoders).
//
// The SubmitterService still constructs a Solana Connection and calls its
// off-chain loadEndpoint() before dispatching to the adapter. We fake the
// Solana RPC + decoders so that off-chain step resolves without hitting
// devnet. This is egress substitution, NOT the EVM seam under test.
// ---------------------------------------------------------------------------

const getAccountInfoMock = vi.fn();
const decodeEndpointConfigMock = vi.fn();
const decodeCoveragePoolMock = vi.fn();
const decodeTreasuryMock = vi.fn();

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: getAccountInfoMock,
    })),
  };
});

vi.mock("@pact-network/protocol-v1-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pact-network/protocol-v1-client")>();
  return {
    ...actual,
    decodeEndpointConfig: (...a: unknown[]) => decodeEndpointConfigMock(...a),
    decodeCoveragePool: (...a: unknown[]) => decodeCoveragePoolMock(...a),
    decodeTreasury: (...a: unknown[]) => decodeTreasuryMock(...a),
  };
});

// axios is auto-mocked so the real IndexerPusherService's POST is captured
// (the indexer push body) without a server. The pusher logic stays real.
vi.mock("axios");

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const TREASURY_VAULT = Keypair.generate().publicKey.toBase58();

function wireSolanaStubs(): void {
  getAccountInfoMock.mockResolvedValue({ data: Buffer.from("stub") });
  decodeEndpointConfigMock.mockReturnValue({
    bump: 254,
    paused: false,
    slug: new TextEncoder().encode("helius".padEnd(16, "\0")).slice(0, 16),
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
    coveragePool: TREASURY_VAULT,
    feeRecipientCount: 1,
    feeRecipients: [
      { kind: FeeRecipientKind.Treasury, destination: TREASURY_VAULT, bps: 1000 },
    ],
  });
  decodeCoveragePoolMock.mockReturnValue({
    bump: 254,
    authority: TREASURY_VAULT,
    usdcMint: USDC_MINT,
    usdcVault: TREASURY_VAULT,
    endpointSlug: new Uint8Array(16),
    totalDeposits: 0n,
    totalPremiums: 0n,
    totalRefunds: 0n,
    currentBalance: 1_000_000_000n,
    createdAt: 0n,
  });
  decodeTreasuryMock.mockReturnValue({
    bump: 254,
    authority: TREASURY_VAULT,
    usdcVault: TREASURY_VAULT,
    setAt: 0n,
  });
}

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const env: Record<string, string> = {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID,
    USDC_MINT,
    PACT_ENABLED_NETWORKS: "arc-testnet",
    PACT_LEGACY_DIRECT_SOLANA: "false",
    PACT_SETTLER_KEYPAIR_ARC_TESTNET: ARC_SETTLER_PRIVKEY,
    INDEXER_URL: "http://indexer.local",
    INDEXER_PUSH_SECRET: "secret",
    ...overrides,
  };
  return {
    get: vi.fn().mockImplementation((k: string) => env[k]),
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (env[k] === undefined) throw new Error(`missing ${k}`);
      return env[k];
    }),
  } as unknown as ConfigService;
}

function arcMessage(
  callIdUuid: string,
  premiumLamports: bigint,
  opts: { outcome?: string; refundLamports?: string; slug?: string } = {},
): SettleMessage {
  return {
    id: callIdUuid,
    data: {
      callId: callIdUuid,
      network: "arc-testnet",
      agentPubkey: AGENT_0X,
      endpointSlug: opts.slug ?? "helius",
      premiumLamports: String(premiumLamports),
      refundLamports: opts.refundLamports ?? "0",
      latencyMs: 120,
      outcome: opts.outcome ?? "ok",
      ts: new Date().toISOString(),
      signature: "stub",
    },
    raw: { ack: vi.fn(), nack: vi.fn() } as unknown as SettleMessage["raw"],
  } as unknown as SettleMessage;
}

function solanaMessage(callIdUuid: string, slug = "helius"): SettleMessage {
  const m = arcMessage(callIdUuid, 1000n, { slug });
  (m.data as Record<string, unknown>).network = "solana-devnet";
  (m.data as Record<string, unknown>).agentPubkey =
    Keypair.generate().publicKey.toBase58();
  return m;
}

async function buildSubmitter(): Promise<{
  adapters: AdaptersService;
  submitter: SubmitterService;
}> {
  const config = makeConfig();
  const adapters = new AdaptersService(config);
  adapters.onModuleInit();
  const submitter = new SubmitterService(
    config,
    { keypair: Keypair.generate() } as unknown as SecretLoaderService,
    adapters,
  );
  await submitter.onModuleInit();
  return { adapters, submitter };
}

/** Decode the captured settleBatch calldata into its first event. */
function decodeFirstEvent(calldata: Hex): Record<string, unknown> {
  const decoded = decodeFunctionData({ abi: PactSettlerAbi, data: calldata });
  expect(decoded.functionName).toBe("settleBatch");
  const events = decoded.args![0] as Array<Record<string, unknown>>;
  return events[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MN-04 fix-WP T0 — Arc Testnet settle e2e acceptance gate", () => {
  beforeEach(() => {
    evmCalls = [];
    capturedCalldata = null;
    fakeBalance = 0n;
    fakeAllowance = 0n;
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    getAccountInfoMock.mockReset();
    decodeEndpointConfigMock.mockReset();
    decodeCoveragePoolMock.mockReset();
    decodeTreasuryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Assertion 3 — the headline. The failure trace MUST pass through the real
  // calldata encoder (finding 2: EVM call ids are emitted without the 0x
  // prefix the encoder requires).
  it("submit() reaches the real encoder with a 0x bytes16 call id from the UUID and produces settleBatch calldata", async () => {
    wireSolanaStubs();
    const { submitter } = await buildSubmitter();

    const uuid = "11111111-2222-3333-4444-555555555555";
    const batch: SettleBatch = { messages: [arcMessage(uuid, 2000n)] };

    // Currently RED: SubmitterService builds the EVM call id via
    // parseCallId().reduce(...,"") with NO 0x prefix, so the real encoder's
    // asBytes16() throws before any RPC. This await rejects.
    await submitter.submit(batch);

    expect(capturedCalldata).not.toBeNull();
    const event = decodeFirstEvent(capturedCalldata!);
    const expectedCallId = ("0x" + uuid.replace(/-/g, "")).toLowerCase();
    expect(String(event.callId).toLowerCase()).toBe(expectedCallId);
    expect(String(event.agent).toLowerCase()).toBe(AGENT_0X.toLowerCase());
  });

  // Assertion 4 — refund threading (finding 6: adapters encode refund=premium
  // on breach and the refund amount is never threaded through).
  it("encodes the exact refundLamports on a breach, not the premium", async () => {
    wireSolanaStubs();
    const { submitter } = await buildSubmitter();

    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const premium = 5000n;
    const refund = 3000n;
    const batch: SettleBatch = {
      messages: [
        arcMessage(uuid, premium, {
          outcome: "server_error",
          refundLamports: String(refund),
        }),
      ],
    };

    await submitter.submit(batch);

    const event = decodeFirstEvent(capturedCalldata!);
    expect(BigInt(event.premium as bigint)).toBe(premium);
    expect(BigInt(event.refund as bigint)).toBe(refund);
    expect(BigInt(event.refund as bigint)).not.toBe(premium);
  });

  // Assertion 2 — ERC-20 read via the EVM adapter, not Solana PDAs.
  it("reads ERC-20 balance/allowance via the EVM adapter (eth_call), never Solana", async () => {
    // Build ONLY the adapter registry (no SubmitterService boot, which would
    // do a Solana treasury read at startup). The eligibility read must be
    // pure EVM.
    const adapters = new AdaptersService(makeConfig());
    adapters.onModuleInit();
    fakeBalance = 10_000n;
    fakeAllowance = 10_000n;
    evmCalls = [];

    const adapter = adapters.getAdapter("arc-testnet");
    const result = await adapter.checkAgentEligibility(AGENT_0X, 1000n);

    expect(result.eligible).toBe(true);
    expect(evmCalls.some((c) => c.method === "eth_call")).toBe(true);
    // No Solana account reads happened on the ERC-20 eligibility path.
    expect(getAccountInfoMock).not.toHaveBeenCalled();
  });

  // Assertion 5 — the indexer writes every aggregate row under arc-testnet.
  // Real IndexerPusherService builds the body; real EventsService ingests it
  // against an in-memory fake Postgres client.
  it("indexer ingest writes Settlement / endpoint / PoolState / recipient-share rows ALL under arc-testnet", async () => {
    const axios = await import("axios");
    const postSpy = vi.mocked(axios.default.post);
    postSpy.mockReset();
    postSpy.mockResolvedValue({ status: 200 } as never);

    const config = makeConfig();
    const pusher = new IndexerPusherService(config);

    const batch: SettleBatch = {
      messages: [arcMessage("dddddddd-1111-2222-3333-444444444444", 2000n)],
    };
    const outcome: SettlementOutcome = {
      signature: FAKE_TX_HASH,
      perEventShares: [
        [
          {
            kind: FeeRecipientKind.Treasury,
            pubkey: AGENT_0X,
            amountLamports: 200n,
          },
        ],
      ],
    };

    // Real pusher builds + POSTs the body (captured via the axios mock).
    await pusher.push(outcome, batch);
    const body = postSpy.mock.calls.at(-1)![1] as Record<string, unknown>;

    // Finding 5a: the pusher must stamp the batch-level network.
    expect(body.network).toBe("arc-testnet");

    // Feed the real body into the real indexer EventsService with a fake
    // Postgres client that records every persisted row's network.
    const { EventsService } = await import(
      "../../indexer/src/events/events.service.js"
    );
    const recorded: Array<{ table: string; network: unknown }> = [];
    const record = (table: string) => (args: { data?: Record<string, unknown> }) => {
      const data = args?.data ?? {};
      if ("network" in data) recorded.push({ table, network: data.network });
      return Promise.resolve(data);
    };
    const tx = {
      agent: { upsert: record("agent"), update: record("agent") },
      endpoint: { upsert: record("endpoint") },
      call: { create: record("call") },
      settlement: { upsert: record("settlement") },
      settlementRecipientShare: {
        count: () => Promise.resolve(0),
        createMany: (args: { data: Array<Record<string, unknown>> }) => {
          for (const row of args.data)
            recorded.push({ table: "settlementRecipientShare", network: row.network });
          return Promise.resolve({ count: args.data.length });
        },
      },
      recipientEarnings: { upsert: record("recipientEarnings") },
      poolState: { upsert: record("poolState") },
    };
    const fakePrisma = {
      $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    };

    const svc = new EventsService(fakePrisma as never);
    await svc.ingest(body as never);

    const aggregateTables = recorded.filter((r) => r.table !== "agent");
    expect(aggregateTables.length).toBeGreaterThan(0);
    for (const row of aggregateTables) {
      expect(row.network).toBe("arc-testnet");
    }
    const networks = new Set(aggregateTables.map((r) => r.network));
    expect(networks.has("solana-devnet")).toBe(false);
  });

  // Assertion 1 — EVM agent (0x / secp256k1 EIP-191) authenticates through the
  // real proxy middleware (finding 3: middleware is Ed25519/bs58-only).
  it("authenticates a 0x / secp256k1 (EIP-191) agent through the real proxy auth middleware", async () => {
    const { Hono } = await import("hono");
    const { verifyPactSignature, buildSignaturePayload } = await import(
      "../../market-proxy/src/middleware/verify-signature.js"
    );

    const app = new Hono();
    app.use("*", verifyPactSignature());
    app.get("/v1/helius/ping", (c) => c.text("ok"));

    const path = "/v1/helius/ping";
    const timestampMs = Date.now();
    const nonce = "arc-e2e-nonce-1";
    const payload = buildSignaturePayload({
      method: "GET",
      path,
      timestampMs,
      nonce,
      bodyHash: "",
    });
    const signature = await AGENT_ACCOUNT.signMessage({ message: payload });

    const res = await app.request(path, {
      method: "GET",
      headers: {
        "x-pact-agent": AGENT_0X,
        "x-pact-timestamp": String(timestampMs),
        "x-pact-nonce": nonce,
        "x-pact-signature": signature,
        "x-pact-project": "demo",
      },
    });

    // RED: the Ed25519-only middleware bs58-decodes the 0x address, fails the
    // length/verify check, and returns 401.
    expect(res.status).not.toBe(401);
  });

  // Assertion 6 — mixed-network / mixed-slug pending partitions correctly.
  it("partitions a mixed-network pending set into single-network batches", async () => {
    const batcher = new BatcherService();
    const flushed: SettleBatch[] = [];
    batcher.setFlushCallback(async (b) => {
      flushed.push(b);
    });

    batcher.push(solanaMessage("00000000-0000-0000-0000-000000000001"));
    batcher.push(arcMessage("00000000-0000-0000-0000-000000000002", 2000n));
    await batcher.flush();

    expect(flushed.length).toBeGreaterThan(0);
    for (const b of flushed) {
      const networks = new Set(
        b.messages.map((m) => (m.data as Record<string, unknown>).network),
      );
      // RED: the batcher splices ALL pending into one batch, so a mixed-network
      // flush yields a single batch with two networks and the submitter routes
      // the whole thing by message[0].
      expect(networks.size).toBe(1);
    }
  });

  it("partitions a mixed-slug pending set into single-slug batches", async () => {
    const batcher = new BatcherService();
    const flushed: SettleBatch[] = [];
    batcher.setFlushCallback(async (b) => {
      flushed.push(b);
    });

    batcher.push(
      arcMessage("00000000-0000-0000-0000-000000000003", 2000n, { slug: "helius" }),
    );
    batcher.push(
      arcMessage("00000000-0000-0000-0000-000000000004", 2000n, { slug: "jupiter" }),
    );
    await batcher.flush();

    expect(flushed.length).toBeGreaterThan(0);
    for (const b of flushed) {
      const slugs = new Set(
        b.messages.map((m) => (m.data as Record<string, unknown>).endpointSlug),
      );
      expect(slugs.size).toBe(1);
    }
  });
});
