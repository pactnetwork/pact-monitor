import { LRUCache } from 'lru-cache';
import { slugBytes16, type PactCoreClient } from '@pact-network/protocol-zerog-client';
import type { EndpointConfig } from '@pact-network/wrap';

export interface ProviderRoute {
  /** 0G Compute provider address (ERC-7857 / broker provider id). */
  provider: `0x${string}`;
  /** Model id the provider serves, e.g. "qwen/qwen-2.5-7b-instruct". */
  model: string;
}

/**
 * Inherently-off-chain slug → 0G-Compute routing. Pricing/SLA/paused are
 * read from PactCore (the authoritative source — `settleBatch` trusts the
 * premium the proxy charges), so ONLY the provider/model live here.
 * Provider liveness must be re-validated before the demo (providers rotate).
 */
export const DEFAULT_PROVIDERS: Record<string, ProviderRoute> = {
  'og-qwen': {
    provider: '0xa48f01287233509FD694a22Bf840225062E67836',
    model: 'qwen/qwen-2.5-7b-instruct',
  },
};

export type ResolvedEndpoint =
  | {
      ok: true;
      provider: `0x${string}`;
      model: string;
      wrapConfig: EndpointConfig;
    }
  | { ok: false; status: 404 | 503; error: string };

interface CachedConfig {
  exists: boolean;
  paused: boolean;
  percentBps: number;
  flatPremium: bigint;
  imputedCost: bigint;
  latencySloMs: number;
}

/**
 * Hybrid resolver (plan-5 locked decision): static provider map + on-chain
 * pricing via `PactCoreClient.getEndpointConfig`, LRU-cached (60s) to keep
 * the hot path off the RPC. 0G is BFT-final so a short positive cache only
 * risks a ≤60s-stale price/pause — acceptable for the demo and bounded.
 */
export function createEndpointResolver(opts: {
  pactCore: Pick<PactCoreClient, 'getEndpointConfig'>;
  providers?: Record<string, ProviderRoute>;
  ttlMs?: number;
}) {
  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  const cache = new LRUCache<string, CachedConfig>({
    max: 256,
    ttl: opts.ttlMs ?? 60_000,
  });

  return {
    async resolve(slug: string): Promise<ResolvedEndpoint> {
      const route = providers[slug];
      if (!route) {
        return { ok: false, status: 404, error: 'endpoint_not_found' };
      }

      let cfg = cache.get(slug);
      if (!cfg) {
        const c = await opts.pactCore.getEndpointConfig(slugBytes16(slug));
        cfg = {
          exists: c.exists,
          paused: c.paused,
          percentBps: c.percentBps,
          flatPremium: c.flatPremium,
          imputedCost: c.imputedCost,
          latencySloMs: c.latencySloMs,
        };
        cache.set(slug, cfg);
      }

      if (!cfg.exists) {
        return { ok: false, status: 404, error: 'endpoint_not_registered' };
      }
      // 5.B — wrap is flat-premium only; a percent-priced endpoint would be
      // silently undercharged and settleBatch would trust the low premium.
      if (cfg.percentBps > 0) {
        return { ok: false, status: 503, error: 'percent_pricing_unsupported' };
      }
      if (cfg.paused) {
        return { ok: false, status: 503, error: 'endpoint_paused' };
      }

      return {
        ok: true,
        provider: route.provider,
        model: route.model,
        wrapConfig: {
          slug,
          sla_latency_ms: cfg.latencySloMs,
          flat_premium_lamports: cfg.flatPremium,
          imputed_cost_lamports: cfg.imputedCost,
        },
      };
    },
  };
}
