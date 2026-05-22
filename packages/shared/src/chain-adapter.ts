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
    feeRecipientCountHint: number;
    /**
     * Per-call latency in ms. Written verbatim into the on-chain CallRecord.
     * NOT used for breach logic (the on-chain program does not compare).
     * The wrap classifier and the off-chain indexer use this; the adapter
     * just passes it through.
     */
    latencyMs: number;
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
   * Single-slug endpoint read. Lets the settler derive an EVM endpoint's fee
   * fan-out without a full readEndpointConfigs() log-scan, and crucially
   * without ever touching Solana PDAs for a non-Solana network. Optional: the
   * SolanaAdapter does not implement it (the settler reads Solana fee config
   * via its own EndpointConfig/CoveragePool PDA cache).
   */
  getEndpoint?(slug: string): Promise<EndpointConfigSnapshot>;
  submitSettleBatch(input: SettleBatchInput): Promise<SettleBatchResult>;
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
