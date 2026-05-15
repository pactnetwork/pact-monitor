import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  verifyPactSignature,
  buildSignaturePayload,
  createInMemoryReplayCache,
} from '../src/auth';

const acct = privateKeyToAccount(('0x' + '1'.repeat(64)) as `0x${string}`);
const PROJECT = 'pact-0g';

function makeCtx(headers: Record<string, string>, url = 'https://h/v1/og-qwen/chat') {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  let jsonResp: { obj: unknown; status: number } | null = null;
  const stored: Record<string, unknown> = {};
  const c = {
    req: {
      header: (n: string) => lower[n.toLowerCase()],
      raw: new Request(url, { method: 'GET' }),
      url,
      method: 'GET',
    },
    json: (obj: unknown, status = 200) => {
      jsonResp = { obj, status };
      return new Response(JSON.stringify(obj), { status });
    },
    set: (k: string, v: unknown) => {
      stored[k] = v;
    },
  };
  return { c: c as never, stored, getJson: () => jsonResp };
}

async function signedHeaders(over: Partial<{ ts: number; nonce: string }> = {}) {
  const ts = over.ts ?? Date.now();
  const nonce = over.nonce ?? 'nonce-1';
  const payload = buildSignaturePayload({
    method: 'GET',
    path: '/v1/og-qwen/chat',
    timestampMs: ts,
    nonce,
    bodyHash: '',
  });
  const signature = await acct.signMessage({ message: payload });
  return {
    'x-pact-agent': acct.address,
    'x-pact-timestamp': String(ts),
    'x-pact-nonce': nonce,
    'x-pact-signature': signature,
    'x-pact-project': PROJECT,
  };
}

describe('verifyPactSignature', () => {
  it('passes through (no-op) when x-pact-agent is absent', async () => {
    const mw = verifyPactSignature();
    const { c, getJson } = makeCtx({});
    const next = vi.fn(async () => new Response('ok'));
    await mw(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(getJson()).toBeNull();
  });

  it('accepts a valid EIP-191 personal_sign signature and stashes checksum address', async () => {
    const mw = verifyPactSignature();
    const { c, stored } = makeCtx(await signedHeaders());
    const next = vi.fn(async () => new Response('ok'));
    await mw(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(stored.verifiedAgent).toBe(acct.address);
  });

  it('rejects a tampered signature', async () => {
    const mw = verifyPactSignature();
    const h = await signedHeaders();
    h['x-pact-signature'] = ('0x' + 'f'.repeat(130)) as string;
    const { c, getJson } = makeCtx(h);
    const next = vi.fn(async () => new Response('ok'));
    await mw(c, next);
    expect(next).not.toHaveBeenCalled();
    expect(getJson()?.status).toBe(401);
    expect((getJson()?.obj as { error: string }).error).toBe('pact_auth_bad_sig');
  });

  it('rejects a stale timestamp', async () => {
    const mw = verifyPactSignature({ skewMs: 1000 });
    const { c, getJson } = makeCtx(await signedHeaders({ ts: Date.now() - 60_000 }));
    const next = vi.fn(async () => new Response('ok'));
    await mw(c, next);
    expect(next).not.toHaveBeenCalled();
    expect((getJson()?.obj as { error: string }).error).toBe('pact_auth_stale');
  });

  it('rejects a replayed nonce', async () => {
    const replayCache = createInMemoryReplayCache(60_000);
    const mw = verifyPactSignature({ replayCache });
    const h = await signedHeaders({ nonce: 'dup' });
    const a = makeCtx(h);
    await mw(a.c, vi.fn(async () => new Response('ok')));
    const b = makeCtx(h);
    const next2 = vi.fn(async () => new Response('ok'));
    await mw(b.c, next2);
    expect(next2).not.toHaveBeenCalled();
    expect((b.getJson()?.obj as { error: string }).error).toBe('pact_auth_replay');
  });

  it('rejects when an auth header is missing', async () => {
    const mw = verifyPactSignature();
    const h = await signedHeaders();
    delete (h as Record<string, string>)['x-pact-signature'];
    const { c, getJson } = makeCtx(h);
    const next = vi.fn(async () => new Response('ok'));
    await mw(c, next);
    expect(next).not.toHaveBeenCalled();
    expect((getJson()?.obj as { error: string }).error).toBe('pact_auth_missing');
  });

  it('rejects a non-EVM x-pact-agent', async () => {
    const mw = verifyPactSignature();
    const h = await signedHeaders();
    h['x-pact-agent'] = 'not-an-address';
    const { c, getJson } = makeCtx(h);
    const next = vi.fn(async () => new Response('ok'));
    await mw(c, next);
    expect(next).not.toHaveBeenCalled();
    expect((getJson()?.obj as { error: string }).error).toBe('pact_auth_bad_sig');
  });
});
