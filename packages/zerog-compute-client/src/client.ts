import { ethers, type Wallet } from 'ethers';
// The SDK's ESM build is broken in v0.8.3 (spike 2). The CJS build is fine,
// so we deliberately depend on CommonJS resolution from this package's
// `tsconfig.json` (module: CommonJS) and import the public surface here.
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

export interface ComputeNetworkConfig {
  chainId:           number;
  rpcUrl:            string;
  ledgerContract:    string;
  minLedgerDeposit0G: number;
  subAccountFund0G:   number;
}

export interface ServiceDescriptor {
  provider: string;
  model:    string;
  endpoint: string;
}

export interface InferenceResult {
  body:      unknown;
  latencyMs: number;
  chatId:    string | null;
  teeVerified: boolean | null;
}

/**
 * Pact-0G's compute helper. Wraps `@0gfoundation/0g-compute-ts-sdk`.
 *
 * Flow per spike 2 (2026-05-15):
 *   1. constructor → wallet + provider
 *   2. ensureLedger() → broker.ledger.depositFund(3) if no account yet
 *   3. listChatbotServices() → discover providers
 *   4. prepareProvider(addr) → broker.ledger.transferFund(addr, 'inference', N)
 *      — pre-create the sub-account explicitly instead of relying on
 *      auto-funding magic during getRequestHeaders
 *   5. callInference({ provider, body }) → fetch + processResponse
 */
export class ZerogComputeClient {
  private broker: any = null;       // SDK ships no type exports; cast at call sites
  private readonly wallet: Wallet;

  constructor(
    public readonly network: ComputeNetworkConfig,
    privateKey: string,
  ) {
    const provider = new ethers.JsonRpcProvider(network.rpcUrl);
    this.wallet    = new ethers.Wallet(privateKey, provider);
  }

  /** Lazily initialize the broker; safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.broker) return;
    this.broker = await createZGComputeNetworkBroker(this.wallet);
  }

  /**
   * Ensure the main ledger account exists. Idempotent: if already deposited,
   * the SDK's internal check skips. On first run sinks `minLedgerDeposit0G` (3 0G).
   */
  async ensureLedger(): Promise<void> {
    await this.init();
    try {
      await this.broker.ledger.depositFund(this.network.minLedgerDeposit0G);
    } catch (err) {
      // "No ledger exists yet… requires minimum of 3 0G" — only thrown when amount < min.
      // "Account already initialized" — fine, swallow.
      const msg = (err as Error).message ?? '';
      if (!/already/i.test(msg)) throw err;
    }
  }

  /** Discover chatbot-typed services live on the network. */
  async listChatbotServices(): Promise<ServiceDescriptor[]> {
    await this.init();
    const services = await this.broker.inference.listService();
    const out: ServiceDescriptor[] = [];
    for (const s of services) {
      if (s.serviceType !== 'chatbot') continue;
      const meta = await this.broker.inference.getServiceMetadata(s.provider);
      out.push({ provider: s.provider, model: meta.model, endpoint: meta.endpoint });
    }
    return out;
  }

  /**
   * Pre-fund the per-provider sub-account so `callInference` won't trigger
   * auto-funding. Spike 2 observed the default auto-fund is 2 0G; setting it
   * explicitly avoids unexpected balance moves.
   */
  async prepareProvider(provider: string, fundAmount0G?: number): Promise<void> {
    await this.init();
    const amount = fundAmount0G ?? this.network.subAccountFund0G;
    await this.broker.ledger.transferFund(provider, 'inference', BigInt(amount) * 10n ** 18n);
  }

  /**
   * POST a single chat-completion request through 0G Compute.
   * Mirrors what market-proxy-zerog will do per insured call.
   */
  async callInference(opts: {
    provider:   string;
    messages:   Array<{ role: string; content: string }>;
    teeVerify?: boolean;
  }): Promise<InferenceResult> {
    await this.init();
    const { provider, messages, teeVerify = false } = opts;

    const meta    = await this.broker.inference.getServiceMetadata(provider);
    const headers = await this.broker.inference.getRequestHeaders(provider);

    const t0  = Date.now();
    const res = await fetch(`${meta.endpoint}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify({ model: meta.model, messages }),
    });
    const body      = await res.json();
    const latencyMs = Date.now() - t0;
    const chatId    = res.headers.get('ZG-Res-Key') || (body as { id?: string }).id || null;

    let teeVerified: boolean | null = null;
    if (teeVerify && chatId) {
      try {
        teeVerified = await this.broker.inference.processResponse(provider, chatId);
      } catch {
        teeVerified = false;
      }
    }

    return { body, latencyMs, chatId, teeVerified };
  }
}
