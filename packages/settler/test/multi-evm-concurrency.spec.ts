/**
 * multi-evm-concurrency.spec.ts — Concurrent Multi-EVM-Chain WP, Task 0
 * (THE ACCEPTANCE GATE).
 *
 * This is the FAILING acceptance test the whole multi-EVM WP must turn GREEN.
 * It bootstraps ONE settler with TWO EVM chains enabled and proves they settle
 * isolated and in parallel — the property "concurrent multi-EVM" actually means.
 * Today it is RED on the two real gaps:
 *   - assertion 1: the deployment-address env overlay is GLOBAL, not chain-
 *     scoped (addresses.ts resolveDeployment reads PACT_EVM_REGISTRY/POOL/
 *     SETTLER), so two EVM chains collide on the same override.
 *   - assertion 3: the batcher flush loop awaits each (network,slug) group
 *     serially (batcher.service.ts:96-102), so one chain's stalled finality
 *     wait head-of-line-blocks every other chain.
 * Assertions 2 (both encode their own calldata) and 4 (per-chain signer, no
 * shared state) are GREEN today — they prove the harness is wired to the REAL
 * seam, so the RED on 1 and 3 is a real gap, not a harness artifact.
 *
 * Design rule for this file (mirrors arc-testnet-settle-e2e.spec.ts; do not
 * relax it):
 *   - WIRE THE REAL components: the real AdaptersService (which builds TWO real
 *     EvmAdapters), the real BatcherService flush loop, the real PipelineService
 *     dispatch, the real SubmitterService, the real protocol-evm-v1-client
 *     calldata encoder (encodeSettleBatch), the real resolveDeployment overlay.
 *   - SUBSTITUTE ONLY network egress + storage: each chain's viem JSON-RPC
 *     transport (the global `fetch`, routed per-chain by RPC host) and the
 *     queue/indexer/Solana egress. NOTHING here replaces submitSettleBatch,
 *     encodeSettleBatch, or the batcher flush loop — those are the seam under
 *     test, so the failure trace passes THROUGH them.
 *   - INJECT the synthetic 2nd chain WITHOUT polluting the production registry:
 *     getChain() is overlaid for `evm-test-2` only (real EvmAdapter preserved),
 *     and a test-scoped DEPLOYMENTS[999999] base entry is added in beforeEach
 *     and removed in afterEach. chains.json / the source DEPLOYMENTS map are
 *     never touched.
 *
 * Per-chain env-key scheme this gate commits Task 1 to (plan self-review note):
 *   PACT_EVM_<REGISTRY|POOL|SETTLER>_<NETWORK_UPPER>, where NETWORK_UPPER =
 *   network.replace(/-/g, "_").toUpperCase() — matching adapters.service.ts's
 *   keypair/rpc convention. arc-testnet -> ARC_TESTNET, evm-test-2 -> EVM_TEST_2.
 *   This gate sets BOTH the global keys (collision source, RED today) and the
 *   per-chain keys (inert today, the GREEN target after Task 1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { register } from "prom-client";
import { Keypair } from "@solana/web3.js";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  PactRegistryAbi,
  PactSettlerAbi,
  type PactDeployment,
} from "@pact-network/protocol-evm-v1-client";

import { AdaptersService } from "../src/adapters/adapters.service.js";
import { SubmitterService } from "../src/submitter/submitter.service.js";
import { BatcherService } from "../src/batcher/batcher.service.js";
import { PipelineService } from "../src/pipeline/pipeline.service.js";
import { IndexerPusherService } from "../src/indexer/indexer-pusher.service.js";
import type { ConfigService } from "@nestjs/config";
import type { ConsumerService } from "../src/consumer/consumer.service.js";
import type { SecretLoaderService } from "../src/config/secret-loader.service.js";
import type { SettleMessage } from "../src/consumer/consumer.service.js";

// ---------------------------------------------------------------------------
// Synthetic 2nd EVM chain — hoisted so the getChain() mock factory can close
// over it. Distinct chainId 999999, distinct RPC host (so the fetch stub can
// route per-chain), small finality so it confirms on the first poll.
// ---------------------------------------------------------------------------

const SYNTH = vi.hoisted(() => ({
  NETWORK: "evm-test-2",
  CHAIN_ID: 999999,
  RPC_URL: "http://evm-test-2.local",
  USDC: "0x3600000000000000000000000000000000000000",
}));

const PROGRAM_ID = "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ARC_RPC_HOST = "rpc.testnet.arc.network"; // from chains.json
const FAKE_TX_HASH = ("0x" + "ab".repeat(32)) as Hex;

// Real secp256k1 settler signers — DISTINCT per chain (assertion 4).
const ARC_SIGNER_PK = generatePrivateKey();
const B_SIGNER_PK = generatePrivateKey();
const ARC_SIGNER = privateKeyToAccount(ARC_SIGNER_PK);
const B_SIGNER = privateKeyToAccount(B_SIGNER_PK);

// Distinct EVM agents per chain (0x / EIP-55).
const AGENT_ARC = privateKeyToAccount(generatePrivateKey()).address;
const AGENT_B = privateKeyToAccount(generatePrivateKey()).address;

// EVM treasury fee recipient returned by the fake getEndpoint() view.
const TREASURY_EVM = privateKeyToAccount(generatePrivateKey()).address;

// Deployment addresses. The GLOBAL set is what both chains collide on TODAY
// (resolveDeployment only reads the global keys). The PER-CHAIN sets are the
// GREEN target after Task 1. All nine are distinct.
const newAddr = (): Address => privateKeyToAccount(generatePrivateKey()).address;
const G_REGISTRY = newAddr();
const G_POOL = newAddr();
const G_SETTLER = newAddr();
const ARC_REGISTRY = newAddr();
const ARC_POOL = newAddr();
const ARC_SETTLER = newAddr();
const B_REGISTRY = newAddr();
const B_POOL = newAddr();
const B_SETTLER = newAddr();

// The struct EvmAdapter.getEndpoint() decodes from the registry view call.
// One Treasury recipient (10%) + zero-padded FeeRecipient[8] tail.
const GET_ENDPOINT_RESULT = {
  paused: false,
  flatPremium: 1000n,
  percentBps: 0,
  slaLatencyMs: 200,
  imputedCost: 5000n,
  exposureCapPerHour: 1_000_000n,
  totalCalls: 0n,
  totalBreaches: 0n,
  totalPremiums: 0n,
  totalRefunds: 0n,
  currentPeriodStart: 0n,
  currentPeriodRefunds: 0n,
  lastUpdated: 0n,
  feeRecipientCount: 1,
  feeRecipients: [
    { kind: 0, destination: TREASURY_EVM, bps: 1000 },
    ...Array.from({ length: 7 }, () => ({
      kind: 0,
      destination: zeroAddress,
      bps: 0,
    })),
  ],
} as const;

// ---------------------------------------------------------------------------
// Synthetic-chain registry injection (NOT the settle seam).
//
// getChain() throws on the unknown `evm-test-2`, so we overlay it for that one
// network and delegate to the real getChain() for everything else. EvmAdapter,
// SolanaAdapter, and the rest of @pact-network/shared stay 100% REAL via the
// importOriginal spread — only the chain-descriptor lookup is injected.
// ---------------------------------------------------------------------------
vi.mock("@pact-network/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pact-network/shared")>();
  const synthDescriptor = {
    vm: "evm" as const,
    network: SYNTH.NETWORK,
    chainId: SYNTH.CHAIN_ID,
    usdcMint: SYNTH.USDC,
    usdcDecimals: 6,
    rpcUrl: SYNTH.RPC_URL,
    blockTimeMs: 50,
    finalityBlocks: 2,
    deploymentBlock: 1,
  };
  return {
    ...actual,
    getChain: (name: string) =>
      name === SYNTH.NETWORK ? { ...synthDescriptor } : actual.getChain(name),
  };
});

// Solana egress — the SubmitterService constructor unconditionally builds a
// Solana Connection and reads the Treasury at boot (Task 5 gap). Fake the RPC
// so boot resolves without devnet; the EVM submit path never touches it. Not
// the seam under test.
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: vi.fn().mockResolvedValue(null),
    })),
  };
});

// axios auto-mocked so the real IndexerPusherService POST is captured without a
// server; the pusher's body-build logic stays real.
vi.mock("axios");

// ---------------------------------------------------------------------------
// Per-chain viem JSON-RPC transport (the ONLY EVM-side substitution). Both
// EvmAdapters POST over the global `fetch`; we route by RPC host so each chain
// answers independently, capture each chain's settleBatch calldata at
// eth_estimateGas, and let chain A's finality poll hang on demand.
// ---------------------------------------------------------------------------

type ChainTag = "arc" | "b";

let capturedCalldata: { arc: Hex | null; b: Hex | null };
let capturedSettlerTo: { arc: string | null; b: string | null };
let capturedRegistryTo: { arc: string | null; b: string | null };
let arcFinalityDelayMs: number;
let bSettledAt: number | null;
let bSettledResolve: () => void;
let bSettledPromise: Promise<void>;

function resetTransportState(): void {
  capturedCalldata = { arc: null, b: null };
  capturedSettlerTo = { arc: null, b: null };
  capturedRegistryTo = { arc: null, b: null };
  arcFinalityDelayMs = 0;
  bSettledAt = null;
  bSettledPromise = new Promise<void>((r) => {
    bSettledResolve = r;
  });
}

function toHexQty(n: bigint): Hex {
  return ("0x" + n.toString(16)) as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function respond(
  tag: ChainTag,
  method: string,
  params: unknown[],
): Promise<unknown> {
  switch (method) {
    case "eth_chainId":
      return toHexQty(tag === "b" ? BigInt(SYNTH.CHAIN_ID) : 5042002n);
    case "eth_blockNumber":
      // Far ahead of the receipt block (1000) so the finality wait-loop sees
      // depth >= finalityBlocks and returns on the first poll.
      return toHexQty(1_000_000n);
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
      const tx = (params[0] ?? {}) as { data?: Hex; to?: string };
      if (tx.data) {
        capturedCalldata[tag] = tx.data;
        capturedSettlerTo[tag] = tx.to ?? null;
      }
      return toHexQty(21000n);
    }
    case "eth_call": {
      const tx = (params[0] ?? {}) as { to?: string };
      capturedRegistryTo[tag] = tx.to ?? null;
      // EvmAdapter.getEndpoint() -> registry getEndpoint() single view call.
      return encodeFunctionResult({
        abi: PactRegistryAbi,
        functionName: "getEndpoint",
        result: GET_ENDPOINT_RESULT,
      });
    }
    case "eth_sendRawTransaction":
      return FAKE_TX_HASH;
    case "eth_getTransactionReceipt": {
      // Assertion 3: hang chain A's finality-confirmation poll. Under the serial
      // flush loop this blocks chain B from even starting; under a parallel
      // flush B confirms while A is still hanging.
      if (tag === "arc" && arcFinalityDelayMs > 0) {
        await sleep(arcFinalityDelayMs);
      }
      if (tag === "b" && bSettledAt === null) {
        bSettledAt = Date.now();
        bSettledResolve();
      }
      return {
        status: "0x1",
        blockNumber: toHexQty(1000n),
        transactionHash: FAKE_TX_HASH,
      };
    }
    default:
      return "0x";
  }
}

async function fakeFetch(
  input: unknown,
  init?: { body?: unknown },
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as { url?: string }).url ?? String(input);
  const tag: ChainTag = url.includes("evm-test-2") ? "b" : "arc";
  const bodyText = typeof init?.body === "string" ? init.body : "";
  const payload = JSON.parse(bodyText) as
    | { id: number; method: string; params?: unknown[] }
    | Array<{ id: number; method: string; params?: unknown[] }>;
  const handleOne = async (req: {
    id: number;
    method: string;
    params?: unknown[];
  }) => ({
    jsonrpc: "2.0",
    id: req.id,
    result: await respond(tag, req.method, req.params ?? []),
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
// Fixtures + fleet bootstrap
// ---------------------------------------------------------------------------

function makeConfig(): ConfigService {
  const env: Record<string, string> = {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID,
    USDC_MINT,
    PACT_ENABLED_NETWORKS: "arc-testnet,evm-test-2",
    PACT_LEGACY_DIRECT_SOLANA: "false",
    PACT_SETTLER_KEYPAIR_ARC_TESTNET: ARC_SIGNER_PK,
    PACT_SETTLER_KEYPAIR_EVM_TEST_2: B_SIGNER_PK,
    INDEXER_URL: "http://indexer.local",
    INDEXER_PUSH_SECRET: "secret",
  };
  return {
    get: vi.fn().mockImplementation((k: string) => env[k]),
    getOrThrow: vi.fn().mockImplementation((k: string) => {
      if (env[k] === undefined) throw new Error(`missing ${k}`);
      return env[k];
    }),
  } as unknown as ConfigService;
}

/** Minimal queue egress — the Pub/Sub boundary, not the flush seam. */
function makeConsumer(): ConsumerService {
  return {
    setEnqueueCallback: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    get queueLength() {
      return 0;
    },
  } as unknown as ConsumerService;
}

interface Fleet {
  adapters: AdaptersService;
  submitter: SubmitterService;
  batcher: BatcherService;
  pipeline: PipelineService;
}

async function buildFleet(): Promise<Fleet> {
  const config = makeConfig();
  const adapters = new AdaptersService(config);
  adapters.onModuleInit();
  const submitter = new SubmitterService(
    config,
    { keypair: Keypair.generate() } as unknown as SecretLoaderService,
    adapters,
  );
  await submitter.onModuleInit();
  const indexerPusher = new IndexerPusherService(config);
  const batcher = new BatcherService();
  const pipeline = new PipelineService(
    makeConsumer(),
    batcher,
    submitter,
    indexerPusher,
  );
  // Wires the REAL flush callback: batcher.flush -> runTrackedBatch ->
  // processBatch -> submitter.submit -> adapter.submitSettleBatch.
  pipeline.onModuleInit();
  return { adapters, submitter, batcher, pipeline };
}

function evmMessage(
  network: string,
  agent0x: string,
  callIdUuid: string,
  premiumBaseUnits: bigint,
  opts: { outcome?: string; refund?: string; slug?: string } = {},
): SettleMessage {
  return {
    id: callIdUuid,
    data: {
      callId: callIdUuid,
      network,
      agentPubkey: agent0x,
      endpointSlug: opts.slug ?? "helius",
      premiumLamports: String(premiumBaseUnits),
      refundLamports: opts.refund ?? "0",
      latencyMs: 120,
      outcome: opts.outcome ?? "ok",
      ts: new Date().toISOString(),
      signature: "stub",
    },
    ack: vi.fn(),
    nack: vi.fn(),
  } as unknown as SettleMessage;
}

/** Decode captured settleBatch calldata into its first event. */
function decodeFirstEvent(calldata: Hex): Record<string, unknown> {
  const decoded = decodeFunctionData({ abi: PactSettlerAbi, data: calldata });
  expect(decoded.functionName).toBe("settleBatch");
  const events = decoded.args![0] as Array<Record<string, unknown>>;
  return events[0];
}

function readDeployment(adapters: AdaptersService, network: string): PactDeployment {
  // resolveDeployment's output is cached on the EvmAdapter as a private field;
  // read it directly to assert per-chain resolution (not mocking anything).
  return (adapters.getAdapter(network) as unknown as { deployment: PactDeployment })
    .deployment;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("multi-evm WP T0 — two-EVM-chain concurrency acceptance gate", () => {
  beforeEach(() => {
    register.clear(); // prom-client metrics are a singleton; reset per test.
    resetTransportState();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));

    // Test-scoped synthetic deployment base for chain 999999 (registry/pool/
    // settler null -> filled by the env overlay). Removed in afterEach.
    DEPLOYMENTS[SYNTH.CHAIN_ID] = {
      chainId: SYNTH.CHAIN_ID,
      usdc: SYNTH.USDC as Address,
      registry: null,
      pool: null,
      settler: null,
    };

    // GLOBAL keys — what both chains collide on TODAY (RED on assertion 1).
    vi.stubEnv("PACT_EVM_REGISTRY", G_REGISTRY);
    vi.stubEnv("PACT_EVM_POOL", G_POOL);
    vi.stubEnv("PACT_EVM_SETTLER", G_SETTLER);
    // PER-CHAIN keys — inert today, the GREEN target after Task 1.
    vi.stubEnv("PACT_EVM_REGISTRY_ARC_TESTNET", ARC_REGISTRY);
    vi.stubEnv("PACT_EVM_POOL_ARC_TESTNET", ARC_POOL);
    vi.stubEnv("PACT_EVM_SETTLER_ARC_TESTNET", ARC_SETTLER);
    vi.stubEnv("PACT_EVM_REGISTRY_EVM_TEST_2", B_REGISTRY);
    vi.stubEnv("PACT_EVM_POOL_EVM_TEST_2", B_POOL);
    vi.stubEnv("PACT_EVM_SETTLER_EVM_TEST_2", B_SETTLER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete DEPLOYMENTS[SYNTH.CHAIN_ID];
  });

  // Assertion 1 (RED today). Two EVM chains must resolve DIFFERENT deployment
  // addresses. The env overlay is global, so both adapters get the same
  // PACT_EVM_REGISTRY/POOL/SETTLER override and collide.
  it("resolves DISTINCT per-chain registry/pool/settler addresses for the two EVM chains", async () => {
    const { adapters } = await buildFleet();

    const arc = readDeployment(adapters, "arc-testnet");
    const b = readDeployment(adapters, "evm-test-2");

    expect(arc.registry).not.toBe(b.registry);
    expect(arc.pool).not.toBe(b.pool);
    expect(arc.settler).not.toBe(b.settler);
  });

  // Assertion 2 (GREEN today — harness sanity). A flush carrying one batch per
  // chain invokes the REAL submitSettleBatch on BOTH adapters, each running the
  // REAL encoder over its own chain's data (0x bytes16 callId from a real UUID).
  it("settles BOTH chains, each encoding its own chain's settleBatch calldata", async () => {
    const { batcher } = await buildFleet();

    const uuidArc = "11111111-2222-3333-4444-555555555555";
    const uuidB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    batcher.push(evmMessage("arc-testnet", AGENT_ARC, uuidArc, 2000n));
    batcher.push(evmMessage("evm-test-2", AGENT_B, uuidB, 3000n));
    await batcher.flush();

    expect(capturedCalldata.arc).not.toBeNull();
    expect(capturedCalldata.b).not.toBeNull();

    const arcEvent = decodeFirstEvent(capturedCalldata.arc!);
    expect(String(arcEvent.callId).toLowerCase()).toBe(
      ("0x" + uuidArc.replace(/-/g, "")).toLowerCase(),
    );
    expect(String(arcEvent.agent).toLowerCase()).toBe(AGENT_ARC.toLowerCase());

    const bEvent = decodeFirstEvent(capturedCalldata.b!);
    expect(String(bEvent.callId).toLowerCase()).toBe(
      ("0x" + uuidB.replace(/-/g, "")).toLowerCase(),
    );
    expect(String(bEvent.agent).toLowerCase()).toBe(AGENT_B.toLowerCase());
  });

  // Assertion 3 (RED today). Chain A's finality poll hangs; chain B's
  // settlement must still complete in a bound far below A's hang — proving B
  // did NOT wait serially behind A. The serial for-await at
  // batcher.service.ts:96-102 makes B wait for A's full (delayed) settlement.
  it(
    "isolates a hung chain: chain B settles in parallel without waiting behind chain A",
    async () => {
      const { batcher } = await buildFleet();

      const ARC_HANG_MS = 2500;
      const B_BOUND_MS = 1000; // B is all-instant fakes; << ARC_HANG_MS.
      arcFinalityDelayMs = ARC_HANG_MS;

      // Push A (the chain that will hang) FIRST so the serial loop processes it
      // before B; insertion order is preserved by the batcher partition.
      batcher.push(evmMessage("arc-testnet", AGENT_ARC, "33333333-3333-3333-3333-333333333333", 2000n));
      batcher.push(evmMessage("evm-test-2", AGENT_B, "44444444-4444-4444-4444-444444444444", 3000n));

      const t0 = Date.now();
      const flushPromise = batcher.flush();
      await bSettledPromise; // resolves when B's finality poll is answered
      const bElapsed = (bSettledAt as number) - t0;
      await flushPromise; // let A finish so no dangling work

      expect(bElapsed).toBeLessThan(B_BOUND_MS);
    },
    30_000,
  );

  // Assertion 4 (GREEN today — guard). Each chain uses its OWN signer and its
  // OWN adapter instance; no shared mutable state leaks between adapters.
  it("uses a distinct signer and adapter instance per chain (no cross-talk)", async () => {
    const { adapters } = await buildFleet();

    const arcSigner = adapters.getEvmAccount("arc-testnet").address.toLowerCase();
    const bSigner = adapters.getEvmAccount("evm-test-2").address.toLowerCase();
    expect(arcSigner).not.toBe(bSigner);
    expect(arcSigner).toBe(ARC_SIGNER.address.toLowerCase());
    expect(bSigner).toBe(B_SIGNER.address.toLowerCase());

    expect(adapters.getAdapter("arc-testnet")).not.toBe(
      adapters.getAdapter("evm-test-2"),
    );
    expect(readDeployment(adapters, "arc-testnet")).not.toBe(
      readDeployment(adapters, "evm-test-2"),
    );
  });
});
