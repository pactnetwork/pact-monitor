import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createProviderMetaCache,
  getContext,
  setContextForTest,
} from '../src/context';

afterEach(() => setContextForTest(null));

describe('createProviderMetaCache', () => {
  it('fills from listChatbotServices once and is idempotent', async () => {
    const listChatbotServices = vi.fn(async () => [
      { provider: '0xABC', model: 'm/1', endpoint: 'https://a/v1' },
    ]);
    const cache = createProviderMetaCache({ listChatbotServices });
    await cache.ensure();
    await cache.ensure();
    expect(listChatbotServices).toHaveBeenCalledTimes(1);
    // case-insensitive provider lookup
    expect(cache.get('0xabc')).toEqual({ endpoint: 'https://a/v1', model: 'm/1' });
    expect(cache.get('0xMISSING')).toBeUndefined();
  });

  it('dedupes concurrent ensure() calls', async () => {
    const listChatbotServices = vi.fn(
      async () =>
        new Promise<{ provider: string; model: string; endpoint: string }[]>(
          (r) => setTimeout(() => r([{ provider: '0x1', model: 'm', endpoint: 'e' }]), 10),
        ),
    );
    const cache = createProviderMetaCache({ listChatbotServices });
    await Promise.all([cache.ensure(), cache.ensure(), cache.ensure()]);
    expect(listChatbotServices).toHaveBeenCalledTimes(1);
  });
});

describe('getContext', () => {
  it('throws before initContext', () => {
    expect(() => getContext()).toThrow(/not initialised/);
  });
});
