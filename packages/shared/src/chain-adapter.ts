/**
 * `ChainAdapter` — the chain-touch seam for the Multi-Network refactor.
 *
 * Per arch §3 L2 (REV1): service code holds an `adapter: ChainAdapter`,
 * NOT a `Connection` or an `ethers.Provider`. WP-MN-02 lands the
 * interface + the SolanaAdapter passthrough; WP-MN-03b swaps services.
 *
 * REV1 enforcement: no symmetric `watch(fromBlockOrSlot)` method. Per-call
 * ingestion stays PUSH (settler → POST /events → indexer). The adapter
 * exposes `readEndpointConfigs()` for the 5-min EndpointConfig refresh and
 * an OPTIONAL `tailSettlementEvents?()` for chains without a settler push.
 */

/** Virtual-machine family. */
export type ChainVm = "solana" | "evm";

/** Static descriptor for one network. Owned by `packages/shared/src/chains.ts`. */
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
  /** EVM only — block tag for finality checks. Default "finalized". Base/OP Stack chains may use "safe". */
  finalityBlockTag?: "safe" | "finalized";
  /**
   * EVM only — inclusive `eth_getLogs` block-range size for the
   * EndpointRegistered discovery scan. Public RPCs cap this per provider:
   * `sepolia.base.org` rejects ranges > 500 with `InvalidParamsRpcError`;
   * Arc Testnet accepts up to 10 000. Fed into `EvmAdapter` so the chunk loop
   * stays inside each chain's cap. Falls back to a conservative default
   * (`EvmAdapter.DEFAULT_LOG_RANGE_CHUNK`) when omitted.
   */
  logRangeChunk?: number;
}

export interface EndpointConfigSnapshot {
  slug: string;
  authority: string;
  maxTotalFeeBps: number;
  feeRecipients: ReadonlyArray<{
    recipient: string;
    bps: number;
    kind: number;
  }>;
  paused: boolean;
  raw: unknown;
}

export interface SettleBatchInput {
  slug: string;
  signer: unknown;
  events: ReadonlyArray<{
    callId: string;
    agent: string;
    premiumBaseUnits: bigint;
    outcome: "ok" | "breach";
    /**
     * Exact refund (base units) supplied by the wrap classifier. The on-chain
     * handler pays this value verbatim (Solana settle_batch.rs uses the wire
     * `refund_lamports` field directly, clamped only by the exposure cap and
     * pool balance — it is NOT derived from premium or gated by breach). Both
     * adapters MUST encode this exact value. Optional for backward compat;
     * defaults to 0 (e.g. a successful call refunds nothing).
     */
    refundBaseUnits?: bigint;
    feeRecipientCountHint: number;
    /**
     * Per-call latency in ms. Written verbatim into the on-chain CallRecord.
     * NOT used for breach logic (the on-chain program does not compare).
     * The wrap classifier and the off-chain indexer use this; the adapter
     * just passes it through.
     */
    latencyMs: number;
    /**
     * Canonical wrapped-call timestamp (unix seconds) taken from the queued
     * settlement event's `ts` field, parsed identically to the legacy-direct
     * path (settler `parseEventTimestamp`). The on-chain CallRecord.timestamp
     * must record WRAPPED-CALL time, not settler-EXEC time, so both adapters
     * encode this exact value instead of synthesizing `Date.now()` at submit
     * time. VM-neutral, alongside refundBaseUnits. Optional for backward
     * compat; adapters fall back to the submit-time clock when unset.
     */
    eventTimestamp?: bigint;
  }>;
  options?: {
    commitment?: "confirmed" | "finalized";
    skipPreflight?: boolean;
  };
}

export interface SettleBatchResult {
  txId: string;
  perEvent: ReadonlyArray<{
    callId: string;
    status: "settled" | "replayed" | "rejected";
    reason?: string;
  }>;
}

export type EligibilityRejectionReason =
  | "insufficient_balance"
  | "insufficient_allowance"
  | "no_account";

export type EligibilityCheckResult =
  | { eligible: true; balance: bigint; allowance: bigint }
  | {
      eligible: false;
      reason: EligibilityRejectionReason;
      balance?: bigint;
      allowance?: bigint;
    };

export interface TailOptions {
  fromBlockOrSlot: string;
  pollIntervalMs?: number;
}

export interface ChainAdapter {
  readonly descriptor: ChainDescriptor;
  readEndpointConfigs(): Promise<ReadonlyArray<EndpointConfigSnapshot>>;
  /**
   * Cursor-able variant of {@link readEndpointConfigs} for chains whose config
   * discovery is a height-scaling log scan (EVM `EndpointRegistered`). Resumes
   * the discovery scan from `fromBlock` (the indexer's persisted per-network
   * cursor; cold start = the chain's `deploymentBlock`) instead of always
   * re-walking from deployment, AND refreshes every `knownSlugs` entry (the
   * endpoints the indexer already tracks) so mutable config changed via
   * `update_config` — which emits no `EndpointRegistered` — stays fresh. Returns
   * the finalized block scanned to, so the caller can persist the next cursor.
   *
   * Optional: chains without a height-scaling scan (Solana `getProgramAccounts`)
   * do not implement it; the indexer falls back to {@link readEndpointConfigs}.
   */
  readEndpointConfigsFrom?(
    fromBlock: bigint,
    knownSlugs?: ReadonlyArray<string>,
  ): Promise<{
    snapshots: ReadonlyArray<EndpointConfigSnapshot>;
    scannedToBlock: bigint;
  }>;
  /**
   * Single-slug endpoint read. Lets the settler derive an EVM endpoint's fee
   * fan-out without a full readEndpointConfigs() log-scan, and crucially
   * without ever touching Solana PDAs for a non-Solana network. Optional: the
   * SolanaAdapter does not implement it (the settler reads Solana fee config
   * via its own EndpointConfig/CoveragePool PDA cache).
   */
  getEndpoint?(slug: string): Promise<EndpointConfigSnapshot>;
  submitSettleBatch(input: SettleBatchInput): Promise<SettleBatchResult>;
  /**
   * Native gas-token balance (in the chain's smallest unit, e.g. wei) of an
   * address — used by the settler's signer gas-balance monitor. Optional: only
   * EVM chains implement it (Solana signer SOL balance is polled directly via
   * the existing web3.js Connection path).
   */
  getNativeBalance?(address: string): Promise<bigint>;
  checkAgentEligibility(
    agent: string,
    requiredBaseUnits: bigint,
  ): Promise<EligibilityCheckResult>;
  tailSettlementEvents?(opts: TailOptions): AsyncIterable<{
    callId: string;
    settlementSig: string;
    blockOrSlot: string;
  }>;
}
