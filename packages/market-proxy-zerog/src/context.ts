// Singleton wiring. `initContext()` is called once at bootstrap; routes read
// it via `getContext()`. Provider endpoint/model is resolved ONCE and cached
// (plan 5.A) so the per-call timed window excludes provider discovery.

import {
  ZerogComputeClient,
  GALILEO_TESTNET,
  ARISTOTLE_MAINNET,
  type ServiceDescriptor,
} from '@pact-network/zerog-compute-client';
import type { BalanceCheck, EventSink } from '@pact-network/wrap';
import { parseEnv, type EnvType } from './env.js';
import { createReadClients, type ReadClients } from './chain.js';
import { createErc20BalanceCheck } from './balance.js';
import {
  createEndpointResolver,
  type ResolvedEndpoint,
} from './endpoints.js';
import { createPubSubSink } from './events.js';

export interface ProviderMeta {
  endpoint: string;
  model: string;
}

/**
 * Lazily-primed `provider → {endpoint,model}` cache. `ensure()` is idempotent
 * and fills the whole map from one `listChatbotServices()` (boot-primed when
 * `ZEROG_COMPUTE_ENSURE_LEDGER`, else on first insured request). Keeps
 * `getServiceMetadata` OFF the wrapFetch-timed path (5.A).
 */
export function createProviderMetaCache(compute: {
  listChatbotServices(): Promise<ServiceDescriptor[]>;
}) {
  const map = new Map<string, ProviderMeta>();
  let primed = false;
  let inflight: Promise<void> | null = null;
  async function fill(): Promise<void> {
    const services = await compute.listChatbotServices();
    for (const s of services) {
      map.set(s.provider.toLowerCase(), { endpoint: s.endpoint, model: s.model });
    }
    primed = true;
  }
  return {
    map,
    get(provider: string): ProviderMeta | undefined {
      return map.get(provider.toLowerCase());
    },
    async ensure(): Promise<void> {
      if (primed) return;
      if (!inflight) inflight = fill().finally(() => (inflight = null));
      await inflight;
    },
  };
}

export type ProviderMetaCache = ReturnType<typeof createProviderMetaCache>;

export interface AppContext {
  env: EnvType;
  read: ReadClients;
  zerogCompute: ZerogComputeClient;
  providerMeta: ProviderMetaCache;
  resolveEndpoint: (slug: string) => Promise<ResolvedEndpoint>;
  balanceCheck: BalanceCheck;
  sink: EventSink;
}

let ctx: AppContext | null = null;

export async function initContext(
  env: EnvType = parseEnv(),
): Promise<AppContext> {
  const preset =
    env.ZEROG_CHAIN_ID === 16_661 ? ARISTOTLE_MAINNET : GALILEO_TESTNET;
  // Honour the operator-supplied RPC over the preset default.
  const network = { ...preset, rpcUrl: env.ZEROG_RPC_URL };

  const read = createReadClients({
    chainId: env.ZEROG_CHAIN_ID,
    rpcUrl: env.ZEROG_RPC_URL,
    pactCoreAddress: env.PACT_CORE_ADDRESS,
  });

  const zerogCompute = new ZerogComputeClient(
    network,
    env.ZEROG_COMPUTE_PRIVATE_KEY,
  );
  const providerMeta = createProviderMetaCache(zerogCompute);

  if (env.ZEROG_COMPUTE_ENSURE_LEDGER) {
    await zerogCompute.ensureLedger(); // fail-loud (narrowed catch, plan 5.H)
    await providerMeta.ensure(); // boot-prime so the hot path stays off RPC
  }

  const balanceCheck = createErc20BalanceCheck({
    publicClient: read.publicClient,
    token: env.USDC_ADDRESS,
    spender: env.PACT_CORE_ADDRESS,
  });
  const sink = createPubSubSink(env.PUBSUB_PROJECT, env.PUBSUB_TOPIC);
  const resolver = createEndpointResolver({ pactCore: read.pactCore });

  ctx = {
    env,
    read,
    zerogCompute,
    providerMeta,
    resolveEndpoint: (slug) => resolver.resolve(slug),
    balanceCheck,
    sink,
  };
  return ctx;
}

export function getContext(): AppContext {
  if (!ctx) throw new Error('market-proxy-zerog context not initialised');
  return ctx;
}

/** Test seam — inject a fully-mocked context. */
export function setContextForTest(c: AppContext | null): void {
  ctx = c;
}
