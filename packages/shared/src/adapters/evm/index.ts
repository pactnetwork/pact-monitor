/**
 * EvmAdapter — real ChainAdapter implementation for EVM networks (WP-MN-04 T2).
 *
 * Replaces EvmAdapterStub (WP-MN-03b) which threw "not implemented" on every
 * method. Wraps @pact-network/protocol-evm-v1-client (viem) and implements:
 *   - readEndpointConfigs(): authority() + EndpointRegistered log scan +
 *     multicall(getEndpoint) -> EndpointConfigSnapshot projection
 *   - submitSettleBatch(): outcome->breach/refund mapping + encodeSettleBatch
 *     + EIP-1559/legacy gas strategy + D6 §5.1 finality wait-loop verbatim
 *   - checkAgentEligibility(): USDC balanceOf + allowance via multicall
 *   - tailSettlementEvents(): async-iter over finalized CallSettled events
 *     for D6 §5.2 reconcile-tail consumer (WP-MN-04 T3 reorg module)
 *
 * CORRECTIONS vs. plan (documented here for captain review):
 *   1. SettlementEventInput has timestamp: bigint field (not in plan) —
 *      set to BigInt(Math.floor(Date.now() / 1000)) per SolanaAdapter pattern.
 *   2. tailSettlementEvents yield shape includes blockOrSlot: string (from
 *      ChainAdapter interface) — set to finalized.number.toString().
 *   3. @pact-network/protocol-evm-v1-client was not in shared's deps —
 *      added as workspace:* to package.json.
 *   4. EndpointRegistered event in PactRegistryAbi has only indexed slug
 *      (no decoded.args.slug plain field) — log.args.slug is the bytes16 hex.
 *   5. perEvent.status simplification: uniformly 'settled' on success;
 *      granular 'replayed'/'rejected' deferred to follow-up (see RESEARCH §3.2).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeSettleBatch,
  getDeployment,
  tryExtractPactError,
  decodePactEventLog,
  PactRegistryAbi,
  PactEventsAbi,
  type PactDeployment,
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

// ---------------------------------------------------------------------------
// Minimal ERC-20 ABI fragments needed for balanceOf + allowance multicall
// ---------------------------------------------------------------------------
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvmAdapterOptions {
  descriptor: ChainDescriptor;
  rpcUrl: string;
  finalityBlocks: number;
  blockTimeMs: number;
  deploymentBlock: bigint;
  signer?: { privateKey: Hex } | { account: PrivateKeyAccount };
  /**
   * Pre-resolved contract addresses. If omitted, falls back to
   * getDeployment(chainId) which uses the baked-in DEPLOYMENTS map.
   * T4 services will pass `resolveDeployment(chainId, process.env)` to
   * honor PACT_EVM_REGISTRY / PACT_EVM_POOL / PACT_EVM_SETTLER overlays.
   */
  deployment?: PactDeployment;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// EvmAdapter
// ---------------------------------------------------------------------------

export class EvmAdapter implements ChainAdapter {
  readonly descriptor: ChainDescriptor;

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | null;
  private readonly finalityBlocks: number;
  private readonly blockTimeMs: number;
  private readonly deploymentBlock: bigint;
  private readonly deployment: PactDeployment;

  constructor(opts: EvmAdapterOptions) {
    if (opts.descriptor.vm !== "evm") {
      throw new Error(
        `EvmAdapter requires descriptor.vm === "evm", got "${opts.descriptor.vm}"`,
      );
    }
    if (!opts.descriptor.chainId) {
      throw new Error("EvmAdapter requires descriptor.chainId");
    }
    this.descriptor = opts.descriptor;
    this.finalityBlocks = opts.finalityBlocks;
    this.blockTimeMs = opts.blockTimeMs;
    this.deploymentBlock = opts.deploymentBlock;
    // Cache deployment at construction time. Caller passes `deployment`
    // (typically resolveDeployment(chainId, process.env)) to honor env
    // overlays; otherwise falls back to the baked-in DEPLOYMENTS map.
    this.deployment = opts.deployment ?? getDeployment(opts.descriptor.chainId);

    const transport = http(opts.rpcUrl);

    // viem chain object: only chainId is strictly required for our use cases
    const viemChain = opts.descriptor.chainId
      ? ({ id: opts.descriptor.chainId } as Parameters<typeof createPublicClient>[0]["chain"])
      : undefined;

    this.publicClient = createPublicClient({
      chain: viemChain,
      transport,
    }) as PublicClient;

    if (opts.signer) {
      const account =
        "account" in opts.signer
          ? opts.signer.account
          : privateKeyToAccount(opts.signer.privateKey);
      this.walletClient = createWalletClient({
        account,
        chain: viemChain,
        transport,
      }) as WalletClient;
    } else {
      this.walletClient = null;
    }
  }

  // -------------------------------------------------------------------------
  // readEndpointConfigs
  //
  // 1. authority() view for the protocol-wide authority address (EVM has no
  //    per-endpoint authority; authority is protocol-wide).
  // 2. getContractEvents(EndpointRegistered) from deploymentBlock to gather
  //    all registered slugs (bytes16 hex).
  // 3. multicall(getEndpoint(slug)) for each unique slug.
  // 4. Project to EndpointConfigSnapshot:
  //    - authority: protocol-wide (correction #4)
  //    - maxTotalFeeBps: computed from feeRecipients.reduce (no per-endpoint
  //      field on EVM; EVM maxTotalFeeBps is a global protocol constant, not
  //      per-endpoint — we surface the actual sum as a conservative bound)
  //    - feeRecipients: map FeeRecipient{kind,destination,bps} -> {recipient,bps,kind}
  // -------------------------------------------------------------------------
  async readEndpointConfigs(): Promise<ReadonlyArray<EndpointConfigSnapshot>> {
    if (!this.deployment.registry) {
      throw new Error(
        `EvmAdapter.readEndpointConfigs: no registry address for chain ${this.deployment.chainId}`,
      );
    }
    const registryAddr = this.deployment.registry;

    // 1. Get protocol-wide authority (no per-endpoint authority on EVM)
    const authorityAddr = await this.publicClient.readContract({
      address: registryAddr,
      abi: PactRegistryAbi,
      functionName: "authority",
    }) as Address;

    // 2. Fetch all EndpointRegistered events since deployment
    const logs = await this.publicClient.getContractEvents({
      address: registryAddr,
      abi: PactRegistryAbi,
      eventName: "EndpointRegistered",
      fromBlock: this.deploymentBlock,
      toBlock: "finalized",
    });

    if (logs.length === 0) return [];

    // 3. Deduplicate slugs (bytes16 hex)
    const slugSet = new Set<Hex>();
    for (const log of logs) {
      const slug = (log.args as { slug?: Hex }).slug;
      if (slug) slugSet.add(slug.toLowerCase() as Hex);
    }
    const slugs = Array.from(slugSet);

    if (slugs.length === 0) return [];

    // 4. Multicall getEndpoint for each slug
    const configs = await this.publicClient.multicall({
      contracts: slugs.map((s) => ({
        address: registryAddr,
        abi: PactRegistryAbi,
        functionName: "getEndpoint" as const,
        args: [s] as const,
      })),
      allowFailure: false,
    }) as Array<{
      paused: boolean;
      flatPremium: bigint;
      percentBps: number;
      slaLatencyMs: number;
      imputedCost: bigint;
      exposureCapPerHour: bigint;
      totalCalls: bigint;
      totalBreaches: bigint;
      totalPremiums: bigint;
      totalRefunds: bigint;
      currentPeriodStart: bigint;
      currentPeriodRefunds: bigint;
      lastUpdated: bigint;
      feeRecipientCount: number;
      feeRecipients: ReadonlyArray<{ kind: number; destination: Address; bps: number }>;
    }>;

    // 5. Project to EndpointConfigSnapshot
    return configs.map((c, i) => ({
      slug: slugs[i],
      // Protocol-wide authority on EVM (no per-endpoint authority field)
      authority: authorityAddr,
      // EVM has no per-endpoint maxTotalFeeBps field; compute from feeRecipients sum.
      // This is the actual total bps allocated, which serves as a conservative bound.
      maxTotalFeeBps: c.feeRecipients.reduce((s, f) => s + Number(f.bps), 0),
      feeRecipients: c.feeRecipients.map((f) => ({
        recipient: f.destination,
        bps: Number(f.bps),
        kind: Number(f.kind),
      })),
      paused: c.paused,
      raw: c,
    }));
  }

  // -------------------------------------------------------------------------
  // submitSettleBatch
  //
  // Outcome -> breach/refund mapping: copied from SolanaAdapter pattern
  // (breach refunds full premium; ok refunds 0).
  //
  // Gas strategy per D6 §3:
  //   - EIP-1559: estimateFeesPerGas -> maxFeePerGas * 120% / 100, keep
  //     maxPriorityFeePerGas unchanged.
  //   - Fallback (chain rejects EIP-1559): legacy gasPrice * 120% / 100.
  //   - gasLimit: estimateGas * 130% / 100.
  //
  // Finality wait-loop: D6 §5.1 verbatim.
  //   timeout = finalityBlocks * blockTimeMs * 3
  //   poll every blockTimeMs until receipt.blockNumber + finalityBlocks <= current
  //
  // perEvent.status simplification: uniformly 'settled' on success.
  // Granular 'replayed'/'rejected' deferred (requires receipt-log matching
  // against input events — see RESEARCH §3.2 for follow-up scope).
  // -------------------------------------------------------------------------
  async submitSettleBatch(input: SettleBatchInput): Promise<SettleBatchResult> {
    if (!this.walletClient) {
      throw new Error(
        "EvmAdapter.submitSettleBatch: no signer configured — pass signer: { privateKey } or signer: { account } in EvmAdapterOptions",
      );
    }

    if (!this.deployment.settler) {
      throw new Error(
        `EvmAdapter.submitSettleBatch: no settler address for chain ${this.deployment.chainId}`,
      );
    }
    const settlerAddr = this.deployment.settler;

    // Map SettleBatchInput events -> SettlementEventInput[]
    const now = BigInt(Math.floor(Date.now() / 1000));
    const eventsWire: SettlementEventInput[] = input.events.map((e) => ({
      callId: e.callId,
      agent: e.agent as Address,
      endpointSlug: input.slug,
      premium: e.premiumBaseUnits,
      refund: e.outcome === "breach" ? e.premiumBaseUnits : 0n,
      latencyMs: e.latencyMs,
      breach: e.outcome === "breach",
      feeRecipientCountHint: e.feeRecipientCountHint,
      timestamp: now,
    }));

    const calldata = encodeSettleBatch(eventsWire);

    // Gas strategy: try EIP-1559, fall back to legacy gasPrice. If BOTH
    // fail (e.g., RPC down), wrap the underlying error in the standard
    // `settleBatch <what> failed: <reason>` envelope so operator-grep finds it.
    let gasParams: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint } = {};
    try {
      const fees = await this.publicClient.estimateFeesPerGas();
      if (fees.maxFeePerGas != null) {
        gasParams = {
          maxFeePerGas: (fees.maxFeePerGas * 120n) / 100n,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? undefined,
        };
      } else {
        throw new Error("EIP-1559 not supported");
      }
    } catch {
      // Fall back to legacy gasPrice
      try {
        const gp = await this.publicClient.getGasPrice();
        gasParams = { gasPrice: (gp * 120n) / 100n };
      } catch (gasErr) {
        const decoded = tryExtractPactError(gasErr);
        const reason = decoded?.name ?? (gasErr as Error)?.message ?? "unknown";
        throw new Error(`settleBatch gas estimation failed: ${reason}`);
      }
    }

    // Estimate gas limit (+30%)
    // Cast to unknown first to avoid viem's discriminated-union type
    // incompatibility between EIP-1559 and legacy gasPrice params.
    const account = (this.walletClient as WalletClient & { account: { address: Address } }).account;
    let gasLimit: bigint;
    try {
      const estimated = await (this.publicClient.estimateGas as (args: unknown) => Promise<bigint>)({
        account: account.address,
        to: settlerAddr,
        data: calldata,
        ...gasParams,
      });
      gasLimit = (estimated * 130n) / 100n;
    } catch (err) {
      const decoded = tryExtractPactError(err);
      const reason = decoded?.name ?? (err as Error)?.message ?? "unknown";
      throw new Error(`settleBatch estimateGas failed: ${reason}`);
    }

    // Send transaction
    let txHash: Hex;
    try {
      txHash = await (this.walletClient.sendTransaction as (args: unknown) => Promise<Hex>)({
        account: account.address,
        to: settlerAddr,
        data: calldata,
        gas: gasLimit,
        ...gasParams,
      });
    } catch (err) {
      const decoded = tryExtractPactError(err);
      const reason = decoded?.name ?? (err as Error)?.message ?? "unknown";
      throw new Error(`settleBatch send failed: ${reason}`);
    }

    // D6 §5.1 finality wait-loop (verbatim)
    const timeoutMs = this.finalityBlocks * this.blockTimeMs * 3;
    const start = Date.now();

    while (true) {
      const receipt = await this.publicClient
        .getTransactionReceipt({ hash: txHash })
        .catch(() => null);

      if (receipt) {
        if (receipt.status === "reverted") {
          throw new Error(
            `settleBatch tx reverted on-chain: ${txHash}`,
          );
        }
        const current = await this.publicClient.getBlockNumber();
        const depth = current - receipt.blockNumber + 1n;
        if (depth >= BigInt(this.finalityBlocks)) {
          return {
            txId: txHash,
            perEvent: input.events.map((e) => ({
              callId: e.callId,
              // Uniformly 'settled' on success. Granular 'replayed'/'rejected' per-event
              // status requires receipt-log matching against input events — deferred to
              // follow-up; see RESEARCH §3.2.
              status: "settled" as const,
            })),
          };
        }
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `settleBatch finality timeout after ${timeoutMs}ms: ${txHash}`,
        );
      }

      await sleep(this.blockTimeMs);
    }
  }

  // -------------------------------------------------------------------------
  // checkAgentEligibility
  //
  // ERC-20 balanceOf + allowance via multicall. EVM never returns 'no_account'
  // (every address is implicit in EVM).
  // -------------------------------------------------------------------------
  async checkAgentEligibility(
    agent: string,
    requiredBaseUnits: bigint,
  ): Promise<EligibilityCheckResult> {
    const usdc = this.deployment.usdc;
    if (!this.deployment.settler) {
      throw new Error(
        `EvmAdapter.checkAgentEligibility: no settler address for chain ${this.deployment.chainId}`,
      );
    }
    const settlerAddr = this.deployment.settler;

    const [balance, allowance] = await this.publicClient.multicall({
      contracts: [
        {
          address: usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf" as const,
          args: [agent as Address] as const,
        },
        {
          address: usdc,
          abi: ERC20_ABI,
          functionName: "allowance" as const,
          args: [agent as Address, settlerAddr] as const,
        },
      ],
      allowFailure: false,
    }) as [bigint, bigint];

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

  // -------------------------------------------------------------------------
  // tailSettlementEvents (optional)
  //
  // Yields finalized CallSettled events for D6 §5.2 reconcile-tail consumer
  // (WP-MN-04 T3 reorg module). Polls the 'finalized' block tag and advances
  // fromBlock after each sweep.
  // -------------------------------------------------------------------------
  async *tailSettlementEvents(opts: TailOptions): AsyncIterable<{
    callId: string;
    settlementSig: string;
    blockOrSlot: string;
  }> {
    if (!this.deployment.settler) {
      throw new Error(
        `EvmAdapter.tailSettlementEvents: no settler address for chain ${this.deployment.chainId}`,
      );
    }
    const settlerAddr = this.deployment.settler;

    let fromBlock = BigInt(opts.fromBlockOrSlot);
    const pollMs = opts.pollIntervalMs ?? 60_000;

    while (true) {
      const finalized = await this.publicClient.getBlock({ blockTag: "finalized" });
      if (finalized.number == null) {
        await sleep(pollMs);
        continue;
      }

      if (fromBlock <= finalized.number) {
        const logs = await this.publicClient.getContractEvents({
          address: settlerAddr,
          abi: PactEventsAbi,
          eventName: "CallSettled",
          fromBlock,
          toBlock: finalized.number,
        });

        for (const log of logs) {
          const decoded = decodePactEventLog(log as { data: Hex; topics: [Hex, ...Hex[]] });
          if (decoded.eventName === "CallSettled") {
            yield {
              callId: decoded.args["callId"] as string,
              settlementSig: log.transactionHash ?? "",
              blockOrSlot: log.blockNumber?.toString() ?? finalized.number.toString(),
            };
          }
        }

        fromBlock = finalized.number + 1n;
      }

      await sleep(pollMs);
    }
  }
}
