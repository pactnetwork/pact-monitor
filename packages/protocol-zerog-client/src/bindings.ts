import type { Provider, Signer } from 'ethers';
import type { EndpointConfig, FeeRecipient, SettlementRecord } from './types.js';

/**
 * High-level wrapper around the `PactCore` contract. Hides ABI plumbing.
 *
 * TODO(impl): generated via TypeChain (`pnpm typechain`) once
 * protocol-zerog-contracts `forge build` produces the ABI. Until then, all
 * methods throw `NotImplemented` — but the type surface is real so consumers
 * (settler-evm, indexer-evm, market-proxy-zerog) can import the shape.
 */
export class PactCoreClient {
  constructor(
    public readonly address:  string,
    public readonly provider: Provider,
    public readonly signer?:  Signer,
  ) {}

  // ── reads ──────────────────────────────────────────────────────────────

  async getEndpointConfig(_slug: `0x${string}`): Promise<EndpointConfig> {
    throw new Error('PactCoreClient.getEndpointConfig: not implemented');
  }

  async getFeeRecipients(_slug: `0x${string}`): Promise<FeeRecipient[]> {
    throw new Error('PactCoreClient.getFeeRecipients: not implemented');
  }

  async getPoolBalance(_slug: `0x${string}`): Promise<bigint> {
    throw new Error('PactCoreClient.getPoolBalance: not implemented');
  }

  async getCallStatus(_callId: `0x${string}`): Promise<number> {
    throw new Error('PactCoreClient.getCallStatus: not implemented');
  }

  // ── writes ─────────────────────────────────────────────────────────────

  async settleBatch(_records: SettlementRecord[]): Promise<string /*txHash*/> {
    throw new Error('PactCoreClient.settleBatch: not implemented');
  }

  async topUpCoveragePool(_slug: `0x${string}`, _amount: bigint): Promise<string> {
    throw new Error('PactCoreClient.topUpCoveragePool: not implemented');
  }

  async registerEndpoint(
    _slug: `0x${string}`,
    _cfg: EndpointConfig,
    _recipients: FeeRecipient[],
  ): Promise<string> {
    throw new Error('PactCoreClient.registerEndpoint: not implemented');
  }
}
