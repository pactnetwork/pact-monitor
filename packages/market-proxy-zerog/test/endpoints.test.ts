import { describe, it, expect, vi } from 'vitest';
import { createEndpointResolver, type ProviderRoute } from '../src/endpoints';

const PROVIDERS: Record<string, ProviderRoute> = {
  demo: { provider: ('0x' + '9'.repeat(40)) as `0x${string}`, model: 'm/1' },
};

const cfg = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    agentTokenId: 0n,
    flatPremium: 500n,
    percentBps: 0,
    imputedCost: 5000n,
    latencySloMs: 8000,
    exposureCapPerHour: 0n,
    currentPeriodStart: 0n,
    currentPeriodRefunds: 0n,
    totalCalls: 0n,
    totalBreaches: 0n,
    totalPremiums: 0n,
    totalRefunds: 0n,
    lastUpdated: 0n,
    paused: false,
    exists: true,
    ...over,
  }) as never;

function resolver(getCfg: ReturnType<typeof vi.fn>, ttlMs?: number) {
  return createEndpointResolver({
    pactCore: { getEndpointConfig: getCfg } as never,
    providers: PROVIDERS,
    ttlMs,
  });
}

describe('createEndpointResolver', () => {
  it('404 when slug is not in the static provider map', async () => {
    const get = vi.fn();
    const r = await resolver(get).resolve('nope');
    expect(r).toEqual({ ok: false, status: 404, error: 'endpoint_not_found' });
    expect(get).not.toHaveBeenCalled();
  });

  it('404 when on-chain endpoint does not exist', async () => {
    const get = vi.fn().mockResolvedValue(cfg({ exists: false }));
    expect(await resolver(get).resolve('demo')).toMatchObject({
      ok: false,
      status: 404,
      error: 'endpoint_not_registered',
    });
  });

  it('503 percent_pricing_unsupported when percentBps > 0 (5.B)', async () => {
    const get = vi.fn().mockResolvedValue(cfg({ percentBps: 100 }));
    expect(await resolver(get).resolve('demo')).toMatchObject({
      ok: false,
      status: 503,
      error: 'percent_pricing_unsupported',
    });
  });

  it('503 when paused', async () => {
    const get = vi.fn().mockResolvedValue(cfg({ paused: true }));
    expect(await resolver(get).resolve('demo')).toMatchObject({
      ok: false,
      status: 503,
      error: 'endpoint_paused',
    });
  });

  it('ok maps on-chain pricing → wrap EndpointConfig + static provider/model', async () => {
    const get = vi.fn().mockResolvedValue(cfg());
    const r = await resolver(get).resolve('demo');
    expect(r).toEqual({
      ok: true,
      provider: PROVIDERS.demo.provider,
      model: 'm/1',
      wrapConfig: {
        slug: 'demo',
        sla_latency_ms: 8000,
        flat_premium_lamports: 500n,
        imputed_cost_lamports: 5000n,
      },
    });
  });

  it('caches on-chain config within the TTL (one RPC for repeat hits)', async () => {
    const get = vi.fn().mockResolvedValue(cfg());
    const res = resolver(get);
    await res.resolve('demo');
    await res.resolve('demo');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the TTL expires', async () => {
    const get = vi.fn().mockResolvedValue(cfg());
    const res = resolver(get, 1);
    await res.resolve('demo');
    await new Promise((r) => setTimeout(r, 5));
    await res.resolve('demo');
    expect(get).toHaveBeenCalledTimes(2);
  });
});
