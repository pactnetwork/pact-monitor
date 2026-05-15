import { describe, it, expect, vi } from 'vitest';
import { makeComputeFetchImpl, type InferenceCaller } from '../src/compute-fetch';

const base = {
  provider: '0xprov',
  endpoint: 'https://compute.example/v1/proxy',
  model: 'm/1',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('makeComputeFetchImpl', () => {
  it('success → 200 with body + x-zerog headers, no getServiceMetadata', async () => {
    const callInferenceWith = vi.fn(async () => ({
      body: { id: 'chat-1', choices: [{ message: { content: 'hello' } }] },
      latencyMs: 42,
      chatId: 'chat-1',
      teeVerified: true,
    }));
    const zerogCompute = { callInferenceWith } as InferenceCaller;
    const fetchImpl = makeComputeFetchImpl({ ...base, zerogCompute, teeVerify: true });

    const res = await fetchImpl('zerog-compute://0xprov');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-zerog-chat-id')).toBe('chat-1');
    expect(res.headers.get('x-zerog-tee-verified')).toBe('true');
    expect(await res.json()).toMatchObject({ id: 'chat-1' });
    expect(callInferenceWith).toHaveBeenCalledWith(
      expect.objectContaining({ provider: '0xprov', endpoint: base.endpoint, model: 'm/1' }),
    );
  });

  it('thrown inference → synthetic 502 (server_error path), not a rethrow', async () => {
    const zerogCompute = {
      callInferenceWith: vi.fn(async () => {
        throw new Error('broker down');
      }),
    } as InferenceCaller;
    const fetchImpl = makeComputeFetchImpl({ ...base, zerogCompute });

    const res = await fetchImpl('zerog-compute://0xprov');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'zerog_compute_failed',
      message: 'broker down',
    });
  });

  it('preDelayMs is awaited before the inference call (force-breach latency)', async () => {
    const order: string[] = [];
    const zerogCompute = {
      callInferenceWith: vi.fn(async () => {
        order.push('infer');
        return { body: {}, latencyMs: 1, chatId: null, teeVerified: null };
      }),
    } as InferenceCaller;
    const fetchImpl = makeComputeFetchImpl({ ...base, zerogCompute, preDelayMs: 40 });

    const t0 = Date.now();
    await fetchImpl('zerog-compute://0xprov');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(order).toEqual(['infer']);
  });

  it('null chatId/teeVerified serialize cleanly', async () => {
    const zerogCompute = {
      callInferenceWith: vi.fn(async () => ({
        body: { ok: true },
        latencyMs: 5,
        chatId: null,
        teeVerified: null,
      })),
    } as InferenceCaller;
    const res = await makeComputeFetchImpl({ ...base, zerogCompute })('x');
    expect(res.headers.get('x-zerog-chat-id')).toBe('');
    expect(res.headers.get('x-zerog-tee-verified')).toBe('null');
  });
});
