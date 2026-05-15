import type {
  Account,
  Address,
  Chain,
  Hex,
  PublicClient,
  WalletClient,
} from 'viem';
import { pactCoreAbi } from './abi.js';
import { MAX_FEE_RECIPIENTS } from './constants.js';
import {
  type EndpointConfig,
  type EndpointConfigUpdate,
  type FeeRecipient,
  type Pool,
  type SettlementRecord,
  RecipientKind,
  SettlementStatus,
} from './types.js';

export interface PactCoreClientOpts {
  address: Address;
  publicClient: PublicClient;
  /** Required only for the write methods. */
  walletClient?: WalletClient;
  /** Defaults to the wallet client's account/chain when omitted. */
  account?: Account | Address;
  chain?: Chain;
}

/**
 * Typed viem wrapper around `PactCore`. Reads go through `publicClient`;
 * writes require a `walletClient`. The `endpointConfig` getter flattens the
 * struct into 15 positional outputs (Solidity public-mapping-of-struct
 * behaviour) — `getEndpointConfig` maps them back by DECLARATION ORDER, which
 * `types.test.ts` pins.
 */
export class PactCoreClient {
  readonly address: Address;
  private readonly pub: PublicClient;
  private readonly wallet?: WalletClient;
  private readonly account?: Account | Address;
  private readonly chain?: Chain;

  constructor(opts: PactCoreClientOpts) {
    this.address = opts.address;
    this.pub = opts.publicClient;
    this.wallet = opts.walletClient;
    this.account = opts.account ?? opts.walletClient?.account;
    this.chain = opts.chain ?? opts.walletClient?.chain;
  }

  private read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.pub.readContract({
      address: this.address,
      abi: pactCoreAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  private write(functionName: string, args: readonly unknown[]): Promise<Hex> {
    if (!this.wallet) {
      throw new Error(
        `PactCoreClient.${functionName}: no walletClient provided`,
      );
    }
    if (!this.account) {
      throw new Error(
        `PactCoreClient.${functionName}: no account available for write`,
      );
    }
    return this.wallet.writeContract({
      address: this.address,
      abi: pactCoreAbi,
      functionName: functionName as never,
      args: args as never,
      account: this.account,
      chain: this.chain,
    } as never);
  }

  // ── reads ──────────────────────────────────────────────────────────────

  async admin(): Promise<Address> {
    return this.read<Address>('admin', []);
  }

  async settlementAuthority(): Promise<Address> {
    return this.read<Address>('settlementAuthority', []);
  }

  async protocolPaused(): Promise<boolean> {
    return this.read<boolean>('protocolPaused', []);
  }

  /** Reads + maps the 15 flattened outputs back into struct field order. */
  async getEndpointConfig(slug: Hex): Promise<EndpointConfig> {
    const r = await this.read<readonly unknown[]>('endpointConfig', [slug]);
    return {
      agentTokenId:         r[0] as bigint,
      flatPremium:          r[1] as bigint,
      percentBps:           Number(r[2]),
      imputedCost:          r[3] as bigint,
      latencySloMs:         Number(r[4]),
      exposureCapPerHour:   r[5] as bigint,
      currentPeriodStart:   r[6] as bigint,
      currentPeriodRefunds: r[7] as bigint,
      totalCalls:           r[8] as bigint,
      totalBreaches:        r[9] as bigint,
      totalPremiums:        r[10] as bigint,
      totalRefunds:         r[11] as bigint,
      lastUpdated:          r[12] as bigint,
      paused:               r[13] as boolean,
      exists:               r[14] as boolean,
    };
  }

  async getCoveragePool(slug: Hex): Promise<Pool> {
    const r = await this.read<readonly unknown[]>('coveragePool', [slug]);
    return { balance: r[0] as bigint, totalDeposits: r[1] as bigint };
  }

  /**
   * The public `feeRecipients(slug, index)` getter has no length accessor, so
   * we walk indices 0..MAX_FEE_RECIPIENTS-1 and stop at the first out-of-range
   * revert. Bounded (≤8) so the extra failed call is cheap.
   */
  async getFeeRecipients(slug: Hex): Promise<FeeRecipient[]> {
    const out: FeeRecipient[] = [];
    for (let i = 0; i < MAX_FEE_RECIPIENTS; i++) {
      try {
        const r = await this.read<readonly unknown[]>('feeRecipients', [
          slug,
          BigInt(i),
        ]);
        out.push({
          kind: Number(r[0]) as RecipientKind,
          destination: r[1] as Address,
          bps: Number(r[2]),
        });
      } catch {
        break; // index past array length
      }
    }
    return out;
  }

  async getCallStatus(callId: Hex): Promise<SettlementStatus> {
    const s = await this.read<number>('callStatus', [callId]);
    return Number(s) as SettlementStatus;
  }

  async getRecipientEarnings(slug: Hex, recipient: Address): Promise<bigint> {
    return this.read<bigint>('recipientEarnings', [slug, recipient]);
  }

  // ── writes ─────────────────────────────────────────────────────────────

  registerEndpoint(
    slug: Hex,
    cfg: EndpointConfig,
    recipients: FeeRecipient[],
  ): Promise<Hex> {
    return this.write('registerEndpoint', [slug, cfg, recipients]);
  }

  updateEndpointConfig(slug: Hex, upd: EndpointConfigUpdate): Promise<Hex> {
    return this.write('updateEndpointConfig', [slug, upd]);
  }

  updateFeeRecipients(slug: Hex, recipients: FeeRecipient[]): Promise<Hex> {
    return this.write('updateFeeRecipients', [slug, recipients]);
  }

  pauseEndpoint(slug: Hex, paused: boolean): Promise<Hex> {
    return this.write('pauseEndpoint', [slug, paused]);
  }

  pauseProtocol(paused: boolean): Promise<Hex> {
    return this.write('pauseProtocol', [paused]);
  }

  topUpCoveragePool(slug: Hex, amount: bigint): Promise<Hex> {
    return this.write('topUpCoveragePool', [slug, amount]);
  }

  settleBatch(records: SettlementRecord[]): Promise<Hex> {
    return this.write('settleBatch', [records]);
  }
}
