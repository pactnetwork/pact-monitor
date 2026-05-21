# WP-MN-04 — EvmAdapter Real Impl + Arc Testnet Fleet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the WP-MN-03b `EvmAdapterStub` with a real `EvmAdapter` (viem-based) wrapping `@pact-network/protocol-evm-v1-client`. Ship the per-VM secret loader, indexer `(network,callId)` dedup change, and the reorg-rollback module. Hand off the Arc Testnet fleet-boot runbook to Tu for T6 execution.

**Architecture:** 5 captain-proxy auto-driveable code tasks (T1..T5) + 1 Tu-executable runbook (T6, NOT in this plan).

- T1 — `chains.json` fill (RPC URL, finality, deploy block) + `ChainDescriptor` interface extension.
- T2 — `EvmAdapter` real impl: `readEndpointConfigs`, `submitSettleBatch` (D6 §5.1 wait-loop verbatim), `checkAgentEligibility`, optional `tailSettlementEvents`. Contract-conformance + unit tests.
- T3 — Indexer `(network, callId)` dedup change + new `reorg/` module with `ReorgService.runReconcile` and `reorg:rollback` CLI. Read-only `settlement_reorg_audit` Prisma view (local docker only).
- T4 — Per-VM `SecretLoaderService.loadFor(network)` discriminated-union loader. Solana back-compat preserved. `AdaptersService` in settler/indexer + `buildAdapterMap` in market-proxy construct real `EvmAdapter` when `vm=='evm'`.
- T5 — Settler + market-proxy e2e routing tests with mocked viem (no live RPC).

**Tech Stack:** TypeScript / NestJS / Vitest / pnpm workspaces / viem.

**Branch:** `feat/multi-network-04-evm-fleet` (off `feat/multi-network@d093945` post WP-MN-03b).

**Captain-proxy directives:**
- Atomic commits per task, conventional-commit prefixes.
- NO remote pushes until Gate B closes.
- Production DB never touched — local docker postgres only for the audit view migration.
- Pause-and-escalate on RESEARCH-contradicting findings (especially: viem method not where the docs say; RPC node refuses both EIP-1559 and legacy gasPrice; PactSettler ABI mismatch).

**Source-of-truth references (READ FIRST):**
- D6 reorg/finality policy — `docs/evm/2026-05-20-reorg-policy.md` (the wait-loop algorithm in §5.1, gas strategy in §3, idempotency rule in §4 — implement verbatim).
- CONTEXT — `.planning/phases/mn-04-evm-fleet/mn-04-CONTEXT.md`.
- RESEARCH — `.planning/phases/mn-04-evm-fleet/mn-04-RESEARCH.md` (esp. §3 method-by-method spec, §4 dedup change, §5 secret loader, §6 chains.json fill, §7 reorg module, §8 runbook for context).

**Tu's locked Gate A answers (RESEARCH §13):**
- Q1 RPC URL → `https://rpc.testnet.arc.network` (extracted from `.env`).
- Q2 PactRegistry deploy block → `42953139`.
- Q3+Q4 Settler EOA → reuse `DEPLOYER_PRIVATE_KEY` (addr `0x777d569bd3b0a2de007097a3d7e1687c5e5eb859`); one self-grant tx in T6, not in this plan.
- Q5 Cloud Run min-instances → `1` (T6).
- Q6 `PACT_LEGACY_DIRECT_SOLANA=false` on all services day 1 (T6).

---

## Task 1: `chains.json` fill + `ChainDescriptor` extension

**Goal:** Fill the three `null` fields on `arc-testnet` in `chains.json` and surface them in the registry's `ChainDescriptor` so the EvmAdapter can read them at boot.

**Files:**
- Modify: `packages/program-evm/protocol-evm-v1/config/chains.json`
- Modify: `packages/shared/src/chain-adapter.ts` (`ChainDescriptor` interface)
- Modify: `packages/shared/src/chains.ts` (load new fields from chains.json + propagate)
- Create: `packages/shared/test/chains-evm.test.ts` (or extend existing)

- [ ] **Step 1: Edit `chains.json`** — fill `rpcUrl`, `blockTimeMs`, `finalityBlocks`, add `deploymentBlock`. Final shape:

```json
{
  "arc-testnet": {
    "chainId": 5042002,
    "name": "arc-testnet",
    "usdcAddress": "0x3600000000000000000000000000000000000000",
    "usdcDecimals": 6,
    "rpcUrl": "https://rpc.testnet.arc.network",
    "blockTimeMs": 500,
    "finalityBlocks": 64,
    "deploymentBlock": 42953139
  }
}
```

- [ ] **Step 2: Extend `ChainDescriptor` in `chain-adapter.ts`** — add three OPTIONAL fields (Solana entries leave undefined):

```ts
export interface ChainDescriptor {
  vm: ChainVm;
  network: string;
  chainId?: number;
  usdcMint: string;
  usdcDecimals: number;
  /** EVM only — JSON-RPC endpoint. Read from chains.json. */
  rpcUrl?: string;
  /** EVM only — block time in ms. Used by EvmAdapter wait-loop sleep. D6 §2. */
  blockTimeMs?: number;
  /** EVM only — confirmation depth before a tx is treated as final. D6 §2/§5.1. */
  finalityBlocks?: number;
  /** EVM only — block number where PactRegistry was deployed; `fromBlock` for EndpointRegistered log scan. */
  deploymentBlock?: number;
}
```

- [ ] **Step 3: Edit `chains.ts`** — update the EVM chain-load mapping to propagate the four new fields:

```ts
const _evmChains = JSON.parse(readFileSync(_evmChainsPath, "utf-8")) as Record<
  string,
  {
    chainId: number;
    name: string;
    usdcAddress: string;
    usdcDecimals: number;
    rpcUrl?: string | null;
    blockTimeMs?: number | null;
    finalityBlocks?: number | null;
    deploymentBlock?: number | null;
  }
>;

const _evmEntries: Record<string, ChainDescriptor> = Object.fromEntries(
  Object.entries(_evmChains).map(([name, c]) => [
    name,
    {
      vm: "evm" as const,
      network: name,
      chainId: c.chainId,
      usdcMint: c.usdcAddress,
      usdcDecimals: c.usdcDecimals,
      ...(c.rpcUrl != null && { rpcUrl: c.rpcUrl }),
      ...(c.blockTimeMs != null && { blockTimeMs: c.blockTimeMs }),
      ...(c.finalityBlocks != null && { finalityBlocks: c.finalityBlocks }),
      ...(c.deploymentBlock != null && { deploymentBlock: c.deploymentBlock }),
    },
  ]),
);
```

- [ ] **Step 4: Write/extend test** — `packages/shared/test/chains-evm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getChain, listChains } from "../src/chains";

describe("chains registry — EVM (WP-MN-04 T1)", () => {
  it("arc-testnet exposes deployment block, finality, rpc url, block time", () => {
    const c = getChain("arc-testnet");
    expect(c.vm).toBe("evm");
    expect(c.chainId).toBe(5042002);
    expect(c.rpcUrl).toBe("https://rpc.testnet.arc.network");
    expect(c.blockTimeMs).toBe(500);
    expect(c.finalityBlocks).toBe(64);
    expect(c.deploymentBlock).toBe(42953139);
  });
  it("solana-devnet does NOT carry EVM-only fields", () => {
    const c = getChain("solana-devnet");
    expect(c.vm).toBe("solana");
    expect(c.rpcUrl).toBeUndefined();
    expect(c.blockTimeMs).toBeUndefined();
    expect(c.finalityBlocks).toBeUndefined();
    expect(c.deploymentBlock).toBeUndefined();
  });
});
```

- [ ] **Step 5: Verify**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/shared build
pnpm --filter @pact-network/shared test 2>&1 | tail -15
```
Expected: 23 baseline + 2 new = 25 green. `chains-evm.test.ts` 2/2.

- [ ] **Step 6: Commit**

```bash
git add packages/program-evm/protocol-evm-v1/config/chains.json \
        packages/shared/src/chain-adapter.ts \
        packages/shared/src/chains.ts \
        packages/shared/test/chains-evm.test.ts
git commit -m "feat(shared,evm): chains.json arc-testnet fill + ChainDescriptor extension (WP-MN-04 T1)

Fills the three null fields on arc-testnet in chains.json with Tu's
Gate A locked values (RESEARCH §6):
- rpcUrl: https://rpc.testnet.arc.network
- blockTimeMs: 500 (D6 §2)
- finalityBlocks: 64 (D6 §2)
- deploymentBlock: 42953139 (PactRegistry deploy, from broadcast log)

Extends ChainDescriptor with four optional EVM-only fields. Solana
entries leave them undefined. Consumed by EvmAdapter in WP-MN-04 T2
for the readEndpointConfigs fromBlock cursor and the submit wait-loop
sleep interval."
```

---

## Task 2: `EvmAdapter` real impl + contract-conformance + unit tests

**Goal:** Replace `EvmAdapterStub` with a working `EvmAdapter` that implements all `ChainAdapter` methods against `@pact-network/protocol-evm-v1-client` (viem). Implements D6 §5.1 wait-loop verbatim.

**Files:**
- Replace: `packages/shared/src/adapters/evm/index.ts` (full rewrite — keep filename)
- Create: `packages/shared/test/evm-adapter-contract.test.ts`
- Create: `packages/shared/test/evm-adapter-unit.test.ts`

- [ ] **Step 1: Write the contract-conformance test FIRST** — `packages/shared/test/evm-adapter-contract.test.ts`. Asserts shape parity with WP-MN-02's solana-adapter-contract suite:

```ts
import { describe, it, expect } from "vitest";
import { EvmAdapter } from "../src/adapters/evm";
import { getChain } from "../src/chains";

describe("EvmAdapter — ChainAdapter contract conformance (WP-MN-04 T2)", () => {
  const descriptor = getChain("arc-testnet");
  const adapter = new EvmAdapter({
    descriptor,
    rpcUrl: descriptor.rpcUrl!,
    finalityBlocks: descriptor.finalityBlocks!,
    blockTimeMs: descriptor.blockTimeMs!,
    deploymentBlock: BigInt(descriptor.deploymentBlock!),
  });

  it("descriptor.vm === 'evm'", () => {
    expect(adapter.descriptor.vm).toBe("evm");
  });
  it("rejects non-evm descriptor in constructor", () => {
    expect(() => new EvmAdapter({
      descriptor: getChain("solana-devnet"),
      rpcUrl: "x", finalityBlocks: 1, blockTimeMs: 1, deploymentBlock: 0n,
    })).toThrow(/descriptor\.vm/);
  });
  it("exposes the 3 required methods", () => {
    expect(typeof adapter.readEndpointConfigs).toBe("function");
    expect(typeof adapter.submitSettleBatch).toBe("function");
    expect(typeof adapter.checkAgentEligibility).toBe("function");
  });
  it("optionally exposes tailSettlementEvents", () => {
    expect(typeof adapter.tailSettlementEvents).toBe("function");
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --filter @pact-network/shared test evm-adapter-contract 2>&1 | tail -10
```
Expected: FAIL — `EvmAdapter` is not exported (only `EvmAdapterStub` exists).

- [ ] **Step 3: Implement `EvmAdapter`** — `packages/shared/src/adapters/evm/index.ts`. The full file (replace existing stub-only contents):

```ts
/**
 * EvmAdapter — real ChainAdapter for EVM networks (Arc Testnet first).
 * Replaces the WP-MN-03b EvmAdapterStub. Wraps @pact-network/protocol-evm-v1-client
 * (viem). Implements D6 §5.1 wait-loop verbatim.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  decodeEventLog,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  resolveDeployment,
  encodeSettleBatch,
  decodePactEventLog,
  decodeEndpointConfig,
  decodeRevertReason,
  PactRegistryAbi,
  PactPoolAbi,
  PactSettlerAbi,
  PactEventsAbi,
  FeeRecipientKind,
  type SettlementEventInput,
} from "@pact-network/protocol-evm-v1-client";
import type {
  ChainAdapter,
  ChainDescriptor,
  EligibilityCheckResult,
  EndpointConfigSnapshot,
  SettleBatchInput,
  SettleBatchResult,
  TailOptions,
} from "../../chain-adapter";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
]);

export interface EvmAdapterOptions {
  descriptor: ChainDescriptor;
  rpcUrl: string;
  finalityBlocks: number;
  blockTimeMs: number;
  deploymentBlock: bigint;
  signer?: { privateKey: Hex } | { account: Account };
}

export class EvmAdapter implements ChainAdapter {
  readonly descriptor: ChainDescriptor;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | null;
  private readonly signerAddress: Address | null;
  private readonly addrs: ReturnType<typeof resolveDeployment>;
  private readonly finalityBlocks: number;
  private readonly blockTimeMs: number;
  private readonly deploymentBlock: bigint;

  constructor(opts: EvmAdapterOptions) {
    if (opts.descriptor.vm !== "evm") {
      throw new Error(
        `EvmAdapter requires descriptor.vm === "evm", got "${opts.descriptor.vm}"`,
      );
    }
    if (opts.descriptor.chainId == null) {
      throw new Error("EvmAdapter requires descriptor.chainId");
    }
    this.descriptor = opts.descriptor;
    this.finalityBlocks = opts.finalityBlocks;
    this.blockTimeMs = opts.blockTimeMs;
    this.deploymentBlock = opts.deploymentBlock;
    this.addrs = resolveDeployment(opts.descriptor.chainId, process.env);
    this.publicClient = createPublicClient({ transport: http(opts.rpcUrl) });

    if (opts.signer) {
      const account =
        "privateKey" in opts.signer
          ? privateKeyToAccount(opts.signer.privateKey)
          : opts.signer.account;
      this.walletClient = createWalletClient({
        account,
        transport: http(opts.rpcUrl),
      });
      this.signerAddress = account.address;
    } else {
      this.walletClient = null;
      this.signerAddress = null;
    }
  }

  /** D6 §4 — endpoint config refresh via getContractEvents + multicall. */
  async readEndpointConfigs(): Promise<ReadonlyArray<EndpointConfigSnapshot>> {
    const logs = await this.publicClient.getContractEvents({
      address: this.addrs.registry!,
      abi: PactRegistryAbi,
      eventName: "EndpointRegistered",
      fromBlock: this.deploymentBlock,
      toBlock: "finalized",
    });
    const slugs = Array.from(
      new Set(logs.map((l: any) => l.args.slug as Hex)),
    );
    if (slugs.length === 0) return [];

    const configs = await this.publicClient.multicall({
      contracts: slugs.map((s) => ({
        address: this.addrs.registry!,
        abi: PactRegistryAbi,
        functionName: "endpoints",
        args: [s],
      })),
      allowFailure: false,
    });
    const paused = await this.publicClient.multicall({
      contracts: slugs.map((s) => ({
        address: this.addrs.registry!,
        abi: PactRegistryAbi,
        functionName: "isPaused",
        args: [s],
      })),
      allowFailure: false,
    });

    return configs.map((c: any, i: number): EndpointConfigSnapshot => ({
      slug: slugs[i],
      authority: c.authority,
      maxTotalFeeBps: Number(c.maxTotalFeeBps),
      feeRecipients: (c.feeRecipients as any[]).map((fr) => ({
        recipient: fr.destination,
        bps: Number(fr.bps),
        kind: Number(fr.kind),
      })),
      paused: Boolean(paused[i]),
      raw: c,
    }));
  }

  /** D6 §5.1 — submit + wait-loop verbatim. */
  async submitSettleBatch(input: SettleBatchInput): Promise<SettleBatchResult> {
    if (!this.walletClient || !this.signerAddress) {
      throw new Error("EvmAdapter has no signer; cannot submitSettleBatch");
    }

    const events: SettlementEventInput[] = input.events.map((e) => ({
      callId: e.callId as Hex,
      agent: e.agent as Address,
      premiumBaseUnits: e.premiumBaseUnits,
      outcome: e.outcome === "ok" ? 0 : 1,
      feeRecipientCountHint: e.feeRecipientCountHint,
      latencyMs: e.latencyMs,
    }));
    const calldata = encodeSettleBatch(events);

    // D6 §3 — gas strategy
    let txParams: Record<string, unknown>;
    try {
      const fees = await this.publicClient.estimateFeesPerGas();
      txParams = {
        maxFeePerGas: (fees.maxFeePerGas * 120n) / 100n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    } catch {
      const gp = await this.publicClient.getGasPrice();
      txParams = { gasPrice: (gp * 120n) / 100n };
    }
    const gasLimit =
      ((await this.publicClient.estimateGas({
        account: this.signerAddress,
        to: this.addrs.settler!,
        data: calldata,
      })) *
        130n) /
      100n;

    let txHash: Hex;
    try {
      txHash = await this.walletClient.sendTransaction({
        to: this.addrs.settler!,
        data: calldata,
        gas: gasLimit,
        chain: null,
        ...txParams,
      } as any);
    } catch (err: any) {
      const decoded = decodeRevertReason(err);
      throw new Error(
        `settleBatch send failed: ${decoded?.shortName ?? err?.message ?? "unknown"}`,
      );
    }

    // D6 §5.1 wait-loop verbatim
    const start = Date.now();
    const timeoutMs = this.finalityBlocks * this.blockTimeMs * 3;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const receipt = await this.publicClient
        .getTransactionReceipt({ hash: txHash })
        .catch(() => null);
      if (receipt) {
        if (receipt.status === "reverted") {
          throw new Error(`settleBatch reverted: txHash=${txHash}`);
        }
        const current = await this.publicClient.getBlockNumber();
        const depth = current - receipt.blockNumber + 1n;
        if (depth >= BigInt(this.finalityBlocks)) {
          return {
            txId: txHash,
            perEvent: input.events.map((e) => ({
              callId: e.callId,
              status: "settled" as const,
            })),
          };
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`settleBatch timeout: txHash=${txHash}`);
      }
      await new Promise((r) => setTimeout(r, this.blockTimeMs));
    }
  }

  /** ERC-20 balanceOf + allowance via multicall (RESEARCH §3.3). */
  async checkAgentEligibility(
    agent: string,
    requiredBaseUnits: bigint,
  ): Promise<EligibilityCheckResult> {
    const usdc = this.addrs.usdc;
    const [balance, allowance] = (await this.publicClient.multicall({
      contracts: [
        {
          address: usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [agent as Address],
        },
        {
          address: usdc,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [agent as Address, this.addrs.settler!],
        },
      ],
      allowFailure: false,
    })) as [bigint, bigint];

    if (balance < requiredBaseUnits) {
      return {
        eligible: false,
        reason: "insufficient_balance",
        balance,
        allowance,
      };
    }
    if (allowance < requiredBaseUnits) {
      return {
        eligible: false,
        reason: "insufficient_allowance",
        balance,
        allowance,
      };
    }
    return { eligible: true, balance, allowance };
  }

  /** D6 §5.2 — reconcile-tail consumer for hard-reorg detection (optional). */
  async *tailSettlementEvents(opts: TailOptions): AsyncIterable<{
    callId: string;
    settlementSig: string;
  }> {
    let fromBlock = BigInt(opts.fromBlockOrSlot);
    const poll = opts.pollIntervalMs ?? 60_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const finalized = await this.publicClient.getBlock({
        blockTag: "finalized",
      });
      if (finalized.number == null) {
        await new Promise((r) => setTimeout(r, poll));
        continue;
      }
      const logs = await this.publicClient.getContractEvents({
        address: this.addrs.settler!,
        abi: PactEventsAbi,
        eventName: "CallSettled",
        fromBlock,
        toBlock: finalized.number,
      });
      for (const log of logs as any[]) {
        const decoded = decodePactEventLog(log);
        if (decoded.name === "CallSettled") {
          yield {
            callId: decoded.callId,
            settlementSig: log.transactionHash,
          };
        }
      }
      fromBlock = finalized.number + 1n;
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
```

NOTE TO IMPLEMENTER: if any `protocol-evm-v1-client` import name above doesn't match real exports (e.g., `decodeRevertReason`, `SettlementEventInput`), inspect `packages/protocol-evm-v1-client/src/{encode,errors,state}.ts` and pull the real names. The viem call shapes are correct; only the `@pact-network/protocol-evm-v1-client` symbol names may need adjustment.

- [ ] **Step 4: Run contract-conformance test**

```bash
pnpm --filter @pact-network/shared build
pnpm --filter @pact-network/shared test evm-adapter-contract 2>&1 | tail -10
```
Expected: 4/4 PASS.

- [ ] **Step 5: Write unit tests** — `packages/shared/test/evm-adapter-unit.test.ts`. Mock `viem.createPublicClient` and `viem.createWalletClient` (vitest `vi.mock("viem", ...)`). Tests:
  - `readEndpointConfigs()` returns empty array when getContractEvents returns []. 
  - `readEndpointConfigs()` projects multicall results into snapshots.
  - `submitSettleBatch()` throws if no signer.
  - `submitSettleBatch()` wait-loop: returns `settled` when receipt depth >= finalityBlocks.
  - `submitSettleBatch()` wait-loop: throws timeout when depth never reaches finalityBlocks.
  - `submitSettleBatch()` falls back to legacy gasPrice when estimateFeesPerGas rejects.
  - `checkAgentEligibility()` returns `insufficient_balance` when balance < required.
  - `checkAgentEligibility()` returns `insufficient_allowance` when balance OK but allowance < required.
  - `checkAgentEligibility()` returns `eligible: true` when both OK.

- [ ] **Step 6: Run unit tests**

```bash
pnpm --filter @pact-network/shared test evm-adapter-unit 2>&1 | tail -15
```
Expected: 9/9 PASS. If gas-fallback or wait-loop tests are awkward to mock, simplify to behavioral assertions only.

- [ ] **Step 7: Verify nothing else broke**

```bash
pnpm --filter @pact-network/shared test 2>&1 | tail -10
```
Expected: 25 (after T1) + ~13 new (4 contract + 9 unit) = ~38 green.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/adapters/evm/index.ts \
        packages/shared/test/evm-adapter-contract.test.ts \
        packages/shared/test/evm-adapter-unit.test.ts
git commit -m "feat(shared): EvmAdapter real impl replacing stub (WP-MN-04 T2)

Implements ChainAdapter for EVM networks (Arc Testnet first) wrapping
@pact-network/protocol-evm-v1-client (viem). Replaces the WP-MN-03b
EvmAdapterStub which threw 'not implemented' on every method.

- readEndpointConfigs(): getContractEvents(EndpointRegistered) +
  multicall(endpoints(slug)) + multicall(isPaused(slug)) -> project
  to EndpointConfigSnapshot.
- submitSettleBatch(input): encodeSettleBatch -> sendTransaction with
  EIP-1559 fees (+20% maxFeePerGas) or legacy gasPrice fallback,
  +30% gasLimit; then D6 §5.1 wait-loop verbatim (receipt depth >=
  finalityBlocks before treating as settled; timeout =
  finalityBlocks * blockTimeMs * 3).
- checkAgentEligibility(agent, required): USDC balanceOf + allowance
  via multicall.
- tailSettlementEvents(opts): optional async-iter over finalized
  CallSettled events (D6 §5.2 reconcile-tail).

Tests: 4 contract-conformance (shape parity with SolanaAdapter) + 9
unit tests with mocked viem clients.

Files:
- packages/shared/src/adapters/evm/index.ts (REPLACES EvmAdapterStub)
- packages/shared/test/evm-adapter-contract.test.ts (NEW)
- packages/shared/test/evm-adapter-unit.test.ts (NEW)"
```

---

## Task 3: Indexer `(network, callId)` dedup + reorg-rollback module

**Goal:** Per D6 §4, change `EventsService.ingest()` dedup lookup from `(signature, callId)` to `(network, callId)`. Add new `reorg/` module with reconcile-tail consumer and operator CLI. Add read-only `settlement_reorg_audit` Prisma view (local docker only).

**Files:**
- Modify: `packages/indexer/src/events/events.service.ts`
- Modify: `packages/indexer/src/events/events.service.spec.ts`
- Create: `packages/indexer/src/reorg/reorg.module.ts`
- Create: `packages/indexer/src/reorg/reorg.service.ts`
- Create: `packages/indexer/src/reorg/reorg-rollback.cli.ts`
- Create: `packages/indexer/src/reorg/reorg.service.spec.ts`
- Modify: `packages/indexer/src/app.module.ts` (register ReorgModule)
- Modify: `packages/db/prisma/schema.prisma` (add settlement_reorg_audit view)
- Create: `packages/db/prisma/migrations/<ts>_add_reorg_audit_view/migration.sql` (LOCAL DOCKER ONLY)

- [ ] **Step 1: Write the dedup failing test FIRST** — extend `events.service.spec.ts`:

```ts
describe("EventsService.ingest — (network, callId) dedup (WP-MN-04 T3)", () => {
  it("treats same (network, callId) with different signature as duplicate", async () => {
    const event = { network: "solana-devnet", callId: "CID1", signature: "SIGa", ... };
    await service.ingest(event);                          // first push
    await service.ingest({ ...event, signature: "SIGb" }); // reorg-replay
    const rows = await prisma.settlement.findMany({ where: { callId: "CID1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].signature).toBe("SIGa");  // first write wins
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --filter @pact-network/indexer test events.service 2>&1 | tail -10
```
Expected: FAIL — current code uses `findUnique({network, signature, callId})` which doesn't match.

- [ ] **Step 3: Update `events.service.ts`** — change the dedup lookup:

```ts
// OLD:
// const existing = await this.prisma.settlement.findUnique({
//   where: { network_signature_callId: { network, signature, callId } },
// });

// NEW (D6 §4):
const existing = await this.prisma.settlement.findFirst({
  where: { network, callId },
});
```

The insert path is unchanged. The storage PK `@@id([network, signature, callId])` stays.

- [ ] **Step 4: Run dedup test**

```bash
pnpm --filter @pact-network/indexer test events.service 2>&1 | tail -10
```
Expected: dedup test PASS. Existing tests still PASS (the second-write-different-sig case is the only behavior change; first-write tests are unaffected).

- [ ] **Step 5: Add `settlement_reorg_audit` view** — edit `packages/db/prisma/schema.prisma`:

```prisma
/// Read-only audit view of settlements potentially orphaned by an EVM hard
/// reorg (depth > finalityBlocks). Populated externally by the reorg/
/// ReorgService.runReconcile sweep. Local docker only — production deploy
/// is a separate ops step per Tu's directive.
view settlement_reorg_audit {
  network    String
  callId     String
  signature  String
  amount     BigInt
  detectedAt DateTime

  @@id([network, callId])
  @@map("settlement_reorg_audit")
}
```

Plus the underlying view DDL — create migration:

```bash
cd packages/db
mkdir -p prisma/migrations/$(date -u +%Y%m%d%H%M%S)_add_reorg_audit_view
```

`migration.sql`:
```sql
CREATE OR REPLACE VIEW "settlement_reorg_audit" AS
SELECT s.network, s."callId", s.signature, s.amount, NOW() AS "detectedAt"
FROM "Settlement" s
WHERE FALSE;  -- populated by ReorgService; static SELECT is the schema-shape definition only
```

Apply to local docker only:

```bash
docker ps | grep pact-pg   # confirm local pg running
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pact \
  pnpm --filter @pact-network/db exec prisma migrate dev --name add_reorg_audit_view
```

- [ ] **Step 6: Implement `ReorgService`** — `packages/indexer/src/reorg/reorg.service.ts`:

```ts
import { Injectable, Inject } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ChainAdapter } from "@pact-network/shared";

@Injectable()
export class ReorgService {
  constructor(
    @Inject("PRISMA") private readonly prisma: PrismaClient,
    @Inject("ADAPTER_MAP") private readonly adapters: Map<string, ChainAdapter>,
  ) {}

  /** Re-scan the last 24h of finalized CallSettled events on `network`;
   *  any DB Settlement row not in canonical chain is logged as orphaned. */
  async runReconcile(network: string, fromBlock: bigint): Promise<{ scanned: number; orphans: number }> {
    const adapter = this.adapters.get(network);
    if (!adapter?.tailSettlementEvents) {
      throw new Error(`adapter for ${network} has no tailSettlementEvents`);
    }
    const seenCallIds = new Set<string>();
    let scanned = 0;
    for await (const e of adapter.tailSettlementEvents({ fromBlockOrSlot: String(fromBlock) })) {
      seenCallIds.add(e.callId);
      scanned++;
      if (scanned > 50_000) break; // single-pass safety
    }
    const dbRows = await this.prisma.settlement.findMany({ where: { network } });
    const orphans = dbRows.filter((r: any) => !seenCallIds.has(r.callId));
    // Future: insert orphans into settlement_reorg_audit via raw SQL or refreshed view def
    return { scanned, orphans: orphans.length };
  }

  /** Operator-driven rollback — see D6 §5.2 step 3. */
  async rollback(network: string, callId: string): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      const settlement = await tx.settlement.findFirst({ where: { network, callId } });
      if (!settlement) throw new Error(`no Settlement for ${network}/${callId}`);
      const shares = await tx.settlementRecipientShare.findMany({
        where: { settlementSignature: settlement.signature },
      });
      for (const s of shares) {
        await tx.recipientEarnings.update({
          where: { network_recipient: { network, recipient: s.recipient } },
          data: { totalEarned: { decrement: s.amount } },
        });
      }
      await tx.poolState.update({
        where: { network_slug: { network, slug: settlement.slug } },
        data: { balance: { increment: settlement.amount } },
      });
      await tx.settlementRecipientShare.deleteMany({
        where: { settlementSignature: settlement.signature },
      });
      await tx.settlement.delete({
        where: { network_signature_callId: { network, signature: settlement.signature, callId } },
      });
    });
  }
}
```

NOTE: column names (`balance`, `slug`, etc.) need verifying against the actual Prisma schema. Implementer reads `packages/db/prisma/schema.prisma` first and aligns.

- [ ] **Step 7: Implement `ReorgModule` + CLI** — `reorg.module.ts` registers the service in `AppModule`; `reorg-rollback.cli.ts` is a NestJS standalone application that takes `--network` and `--call-id` flags and calls `service.rollback()`. Reference: existing CLI patterns in `packages/indexer/src/` (operator ops controller is the closest).

- [ ] **Step 8: Write `reorg.service.spec.ts`** — 3 tests:
  - `runReconcile` returns scanned/orphans counts correctly given a mocked adapter.
  - `rollback` decrements PoolState.balance and RecipientEarnings, deletes Settlement + shares atomically.
  - `rollback` throws if Settlement does not exist.

- [ ] **Step 9: Register `ReorgModule`** in `packages/indexer/src/app.module.ts`.

- [ ] **Step 10: Verify**

```bash
pnpm --filter @pact-network/indexer build
pnpm --filter @pact-network/indexer test 2>&1 | tail -15
```
Expected: 84 baseline + 1 dedup test + 3 reorg tests = 88 green.

- [ ] **Step 11: Commit**

```bash
git add packages/indexer/src/events/ \
        packages/indexer/src/reorg/ \
        packages/indexer/src/app.module.ts \
        packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/
git commit -m "feat(indexer,db): (network,callId) dedup + reorg-rollback module (WP-MN-04 T3)

Per D6 §4: EVM reorgs can replay a settlement under a different
txHash, so the dedup key must be chain-stable. Changes
EventsService.ingest() lookup from findUnique({network, signature,
callId}) to findFirst({network, callId}). Storage PK
@@id([network, signature, callId]) unchanged — it's the storage
key, not the dedup key.

Adds packages/indexer/src/reorg/ module:
- ReorgService.runReconcile(network, fromBlock): tail finalized
  CallSettled events via adapter.tailSettlementEvents; identify
  Settlement rows not in canonical chain.
- ReorgService.rollback(network, callId): atomic transaction
  decrementing PoolState.balance + RecipientEarnings, deleting
  Settlement + shares. Per D6 §5.2 step 3.
- reorg:rollback CLI for operator-driven recovery.

Adds settlement_reorg_audit view to Prisma schema. LOCAL DOCKER
ONLY per Tu's directive — production migration is a separate ops
step.

Tests: 1 dedup behavior test + 3 reorg-service unit tests."
```

---

## Task 4: Per-VM `SecretLoaderService.loadFor(network)` + `AdaptersService` EVM construction

**Goal:** Rewrite `SecretLoaderService` to be per-network and per-VM. Solana back-compat preserved (legacy `SETTLEMENT_AUTHORITY_KEY` honored). `AdaptersService` (settler + indexer) and `buildAdapterMap` (market-proxy) construct real `EvmAdapter` for `vm:'evm'` networks.

**Files:**
- Modify: `packages/settler/src/config/secret-loader.service.ts`
- Modify: `packages/settler/src/config/secret-loader.service.spec.ts`
- Modify: `packages/settler/src/adapters/adapters.service.ts`
- Modify: `packages/settler/src/adapters/adapters.service.spec.ts`
- Modify: `packages/indexer/src/adapters/adapters.service.ts`
- Modify: `packages/indexer/src/adapters/adapters.service.spec.ts`
- Modify: `packages/market-proxy/src/lib/context.ts` (`buildAdapterMap`)
- Modify: `packages/market-proxy/test/context.test.ts` (if exists; else create routing test in T5)

- [ ] **Step 1: Read current `SecretLoaderService`** — `cat packages/settler/src/config/secret-loader.service.ts` (already done in RESEARCH §5; reference RESEARCH for the rewrite shape).

- [ ] **Step 2: Write failing tests for `loadFor`** — extend `secret-loader.service.spec.ts`:

```ts
describe("SecretLoaderService.loadFor (WP-MN-04 T4)", () => {
  it("solana-devnet from raw bs58 env returns vm:'solana'", async () => {
    const kp = Keypair.generate();
    const cfg = makeConfig({
      PACT_SETTLER_KEYPAIR_SOLANA_DEVNET: bs58.encode(kp.secretKey),
    });
    const svc = new SecretLoaderService(cfg);
    const loaded = await svc.loadFor("solana-devnet");
    expect(loaded.vm).toBe("solana");
    expect(loaded.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });
  it("arc-testnet from raw 0x-hex env returns vm:'evm'", async () => {
    const hex = "0x" + "11".repeat(32);
    const cfg = makeConfig({ PACT_SETTLER_KEYPAIR_ARC_TESTNET: hex });
    const svc = new SecretLoaderService(cfg);
    const loaded = await svc.loadFor("arc-testnet");
    expect(loaded.vm).toBe("evm");
    expect(loaded.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
  it("solana-devnet legacy SETTLEMENT_AUTHORITY_KEY env still honored", async () => {
    const kp = Keypair.generate();
    const cfg = makeConfig({ SETTLEMENT_AUTHORITY_KEY: bs58.encode(kp.secretKey) });
    const svc = new SecretLoaderService(cfg);
    const loaded = await svc.loadFor("solana-devnet");
    expect(loaded.vm).toBe("solana");
  });
  it("throws when no env value set for the requested network", async () => {
    const cfg = makeConfig({});
    const svc = new SecretLoaderService(cfg);
    await expect(svc.loadFor("arc-testnet")).rejects.toThrow(/no signer secret/);
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
pnpm --filter @pact-network/settler test secret-loader 2>&1 | tail -10
```
Expected: FAIL — `loadFor` doesn't exist.

- [ ] **Step 4: Rewrite `SecretLoaderService`** — `packages/settler/src/config/secret-loader.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { getChain } from "@pact-network/shared";

export type LoadedSigner =
  | { vm: "solana"; keypair: Keypair }
  | { vm: "evm"; account: PrivateKeyAccount; address: Address };

@Injectable()
export class SecretLoaderService {
  private readonly client: SecretManagerServiceClient;

  constructor(private readonly config: ConfigService) {
    this.client = new SecretManagerServiceClient();
  }

  async loadFor(network: string): Promise<LoadedSigner> {
    const desc = getChain(network);
    const envKey = `PACT_SETTLER_KEYPAIR_${network.toUpperCase().replace(/-/g, "_")}`;
    let raw = this.config.get<string>(envKey);
    if (!raw && network === "solana-devnet") {
      raw = this.config.get<string>("SETTLEMENT_AUTHORITY_KEY");
    }
    if (!raw) {
      throw new Error(`no signer secret for network ${network} (env ${envKey})`);
    }
    const value = raw.startsWith("projects/")
      ? await this.fetchSecretManager(raw)
      : raw;

    if (desc.vm === "solana") {
      const bytes = bs58.decode(value.trim());
      return { vm: "solana", keypair: Keypair.fromSecretKey(bytes) };
    }
    // evm
    const hex = (value.trim().startsWith("0x") ? value.trim() : `0x${value.trim()}`) as Hex;
    const account = privateKeyToAccount(hex);
    return { vm: "evm", account, address: account.address };
  }

  private async fetchSecretManager(resourcePath: string): Promise<string> {
    const [version] = await this.client.accessSecretVersion({ name: resourcePath });
    const raw = version.payload?.data;
    if (!raw) throw new Error("Empty secret payload");
    return typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  }
}
```

Legacy `keypair` getter (Solana-only) removed; callers use `loadFor("solana-devnet")` then `.keypair` on the discriminated union. Existing usage in `submitter.service.ts` and elsewhere updates accordingly. **Implementer: search for `secretLoader.keypair` references and migrate to `(await secretLoader.loadFor(network)).keypair`.**

- [ ] **Step 5: Update `AdaptersService` in settler + indexer** — construct real `EvmAdapter` when `vm:'evm'`. In `packages/settler/src/adapters/adapters.service.ts` (and indexer's equivalent), the block that currently creates `EvmAdapterStub`:

```ts
// OLD:
// adapter = new EvmAdapterStub({ descriptor });

// NEW:
const signer = await this.secretLoader.loadFor(network);
if (signer.vm !== "evm") {
  throw new Error(`secret-loader returned wrong vm for ${network}`);
}
adapter = new EvmAdapter({
  descriptor,
  rpcUrl: descriptor.rpcUrl!,
  finalityBlocks: descriptor.finalityBlocks!,
  blockTimeMs: descriptor.blockTimeMs!,
  deploymentBlock: BigInt(descriptor.deploymentBlock!),
  signer: { account: signer.account },
});
```

For the indexer's `AdaptersService` (no signer needed — indexer doesn't sign tx; it reads), pass `signer: undefined`:

```ts
adapter = new EvmAdapter({
  descriptor, rpcUrl: descriptor.rpcUrl!,
  finalityBlocks: descriptor.finalityBlocks!,
  blockTimeMs: descriptor.blockTimeMs!,
  deploymentBlock: BigInt(descriptor.deploymentBlock!),
});
```

For `market-proxy/src/lib/context.ts buildAdapterMap()`: same pattern; market-proxy doesn't sign either (eligibility checks are reads).

- [ ] **Step 6: Update tests** — `adapters.service.spec.ts` for settler + indexer + market-proxy. Existing tests that asserted `EvmAdapterStub` rejection now assert `EvmAdapter` instantiation (or mocked `EvmAdapter` for unit-test isolation). Use `vi.mock("@pact-network/shared", ...)` to stub `EvmAdapter` if needed to avoid live RPC during unit tests.

- [ ] **Step 7: Verify**

```bash
pnpm --filter @pact-network/settler test 2>&1 | tail -15
pnpm --filter @pact-network/indexer test 2>&1 | tail -15
pnpm --filter @pact-network/market-proxy test 2>&1 | tail -15
```
Expected: settler 69 baseline + ~4 secret-loader tests = ~73 green. Indexer 88 (after T3) green. Market-proxy 150 baseline (3 pre-existing fails unchanged).

- [ ] **Step 8: Commit**

```bash
git add packages/settler/src/config/ \
        packages/settler/src/adapters/ \
        packages/indexer/src/adapters/ \
        packages/market-proxy/src/lib/context.ts \
        packages/market-proxy/test/
git commit -m "feat(settler,indexer,market-proxy): per-VM secret loader + real EvmAdapter (WP-MN-04 T4)

SecretLoaderService.loadFor(network) returns a discriminated union:
- { vm: 'solana', keypair: Keypair } from base58 env or projects/...
- { vm: 'evm',    account: PrivateKeyAccount, address: Address } from
  0x-hex env (Phase 1) or projects/... (Phase 2 Rick follow-up).

Legacy SETTLEMENT_AUTHORITY_KEY env honored only for solana-devnet
(back-compat).

AdaptersService in settler + indexer + buildAdapterMap in market-
proxy: construct real EvmAdapter (replacing EvmAdapterStub) when
descriptor.vm === 'evm'. Settler EvmAdapter gets a signer from
loadFor(); indexer + market-proxy EvmAdapter is read-only (no
signer needed).

Tests: 4 secret-loader.loadFor tests + adapter-service tests updated
to assert real EvmAdapter instantiation (mocked viem clients)."
```

---

## Task 5: Arc-testnet routing e2e (mocked viem)

**Goal:** Settler + market-proxy e2e routing tests that exercise the full path with mocked viem. Asserts that events with `network: 'arc-testnet'` route to the real `EvmAdapter` (not the stub) and produce expected calldata, balance reads, and routing decisions.

**Files:**
- Create: `packages/settler/test/arc-testnet-routing.spec.ts`
- Create: `packages/market-proxy/test/arc-testnet-routing.spec.ts`

- [ ] **Step 1: Settler routing test** — `packages/settler/test/arc-testnet-routing.spec.ts`. Boot the settler with `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`, `PACT_SETTLER_KEYPAIR_ARC_TESTNET=0x<test hex>`. Mock viem's `createPublicClient` + `createWalletClient` to return stubs that:
  - return synthetic gas estimates,
  - return a synthetic txHash on sendTransaction,
  - return a receipt with `blockNumber: N` and `getBlockNumber() = N + finalityBlocks` (so wait-loop returns immediately settled).

Push a `SettlementEvent` with `network: 'arc-testnet'`. Assert:
- `submit()` routes to the arc-testnet adapter (not solana-devnet).
- The synthetic txHash is returned.
- `perEventShares` are computed correctly (re-uses `computeFeeSharesForEvent` from WP-MN-03b T5).

- [ ] **Step 2: Market-proxy routing test** — `packages/market-proxy/test/arc-testnet-routing.spec.ts`. Configure two endpoints: one with `network: 'solana-devnet'`, one with `network: 'arc-testnet'`. For each, mock the adapter's `checkAgentEligibility`:
- arc endpoint: stubbed `EvmAdapter.checkAgentEligibility` returns `{eligible: true, balance: 1_000_000n, allowance: 1_000_000n}`.
- solana endpoint: existing balance-check fixture.

Send synthetic requests to both routes; assert each uses the correct adapter. Assert 503 when an endpoint references an unknown network (regression guard from WP-MN-03b T5).

- [ ] **Step 3: Verify**

```bash
pnpm --filter @pact-network/settler test arc-testnet 2>&1 | tail -10
pnpm --filter @pact-network/market-proxy test arc-testnet 2>&1 | tail -10
```
Expected: 4–6 new tests green across both services.

- [ ] **Step 4: Full suite verify**

```bash
pnpm -r --filter '@pact-network/*' test 2>&1 | tail -20
```
Expected: full suite green except the same 3 pre-existing market-proxy `endpoints.test.ts` failures (carry-forward from before WP-MN-01).

- [ ] **Step 5: Commit**

```bash
git add packages/settler/test/arc-testnet-routing.spec.ts \
        packages/market-proxy/test/arc-testnet-routing.spec.ts
git commit -m "test(services): arc-testnet routing e2e with mocked viem (WP-MN-04 T5)

Settler routing: event(network='arc-testnet') -> EvmAdapter route,
synthetic txHash from mocked walletClient, wait-loop returns settled
because mocked publicClient reports depth >= finalityBlocks
immediately. perEventShares unchanged from WP-MN-03b T5.

Market-proxy routing: two endpoints (one solana-devnet, one
arc-testnet) — each routes to the correct adapter's
checkAgentEligibility. Unknown-network endpoint still returns 503
(regression guard).

No live RPC. All viem clients mocked via vi.mock('viem', ...).

This is the WP-MN-04 Gate B headline: the multi-network-per-service
topology proven for real EvmAdapter with mocked viem. The Tu-
executable T6 fleet boot is the only remaining step before Arc
testnet traffic flows."
```

---

## Gate B exit (7-cat) — what to write after T1..T5 close

`.planning/phases/mn-04-evm-fleet/mn-04-REPORT-gateB.md`:

1. **T1..T5 PLANs closed** — list SHAs.
2. **Tests green with counts** — pre/post deltas per package. Expected: shared +~13 (T1 +2, T2 +13); settler +~6 (T4 +4, T5 +2); indexer +~4 (T3 +1 dedup + +3 reorg); market-proxy +~2 (T5 +2). 3 pre-existing market-proxy failures unchanged.
3. **Drift / contract checks** — `evm-adapter-contract.test.ts` 4/4. Arc-testnet routing 4-6/4-6.
4. **Spec parity** — D6 §3/§4/§5.1/§5.2 implemented verbatim; off-chain §2.5/§2.6 satisfied; phased plan §7 deliverables present.
5. **Rollback** — tag `pre-mn-05-rollback`. Fleet disable = remove `arc-testnet` from `PACT_ENABLED_NETWORKS` + roll Cloud Run revisions.
6. **Captain Gate B verdict** — APPROVED expected.
7. **Handoff** — update `~/cockpit-hub/spokes/pact-network/handoff.json`.

## T6 — Tu-executable fleet-boot runbook (NOT in this plan)

After Gate B closes, Tu executes the runbook in `.planning/phases/mn-04-evm-fleet/runbook-fleet-boot.md` (T6 writes this as part of the Gate B closeout). Steps in RESEARCH §8.
