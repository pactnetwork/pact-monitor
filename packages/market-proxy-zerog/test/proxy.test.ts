import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAddress } from 'viem';
import type { SettlementEvent } from '@pact-network/wrap';
import { proxyRoute } from '../src/routes/proxy';
import { setContextForTest, type AppContext } from '../src/context';

const LOWER_AGENT = '0x' + 'a'.repeat(40);
const CHECKSUM = getAddress(LOWER_AGENT);
const PROVIDER = ('0x' + 'p'.repeat(40)) as `0x${string}`;

function buildCtx(over: {
  insecure?: string;
  slaMs?: number;
  inferImpl?: () => Promise<{ body: unknown; latencyMs: number; chatId: string | null; teeVerified: boolean | null }>;
  eligible?: boolean;
}) {
  const events: SettlementEvent[] = [];
  const callInferenceWith = vi.fn(
    over.inferImpl ??
      (async () => ({ body: { id: 'c1', ok: true }, latencyMs: 5, chatId: 'c1', teeVerified: null })),
  );
  const appCtx: AppContext = {
    env: {
      PACT_PROXY_INSECURE_DEMO: over.insecure ?? '0',
      ZEROG_COMPUTE_TEE_VERIFY: false,
    } as never,
    read: {} as never,
    zerogCompute: { callInferenceWith } as never,
    providerMeta: {
      ensure: vi.fn(async () => {}),
      get: () => ({ endpoint: 'https://compute/v1', model: 'm/1' }),
      map: new Map(),
    } as never,
    resolveEndpoint: vi.fn(async (slug: string) => ({
      ok: true as const,
      provider: PROVIDER,
      model: 'm/1',
      wrapConfig: {
        slug,
        sla_latency_ms: over.slaMs ?? 8000,
        flat_premium_lamports: 500n,
        imputed_cost_lamports: 5000n,
      },
    })),
    balanceCheck: {
      check: vi.fn(async () => ({
        eligible: over.eligible ?? true,
        ataBalance: 10n ** 9n,
        allowance: 10n ** 9n,
      })),
    } as never,
    sink: { publish: async (e: SettlementEvent) => void events.push(e) },
  };
  setContextForTest(appCtx);
  return { events, callInferenceWith };
}

function fakeHono(opts: {
  slug?: string;
  verifiedAgent?: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const vars: Record<string, unknown> = {
    verifiedAgent: opts.verifiedAgent,
  };
  let jsonResp: { obj: unknown; status: number } | null = null;
  const c = {
    req: {
      param: (k: string) => (k === 'slug' ? (opts.slug ?? 'og-qwen') : undefined),
      query: (k: string) => opts.query?.[k],
      json: async () => {
        if (opts.body === undefined) throw new Error('no body');
        return opts.body;
      },
    },
    get: (k: string) => vars[k],
    json: (obj: unknown, status = 200) => {
      jsonResp = { obj, status };
      return new Response(JSON.stringify(obj), { status });
    },
  };
  return { c: c as never, getJson: () => jsonResp };
}

afterEach(() => setContextForTest(null));

describe('proxyRoute — cross-package invariants', () => {
  it('INV1+INV2(ok): publishes a checksummed agentPubkey + classifier premium/refund', async () => {
    const { events } = buildCtx({});
    const { c } = fakeHono({
      verifiedAgent: CHECKSUM,
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const res = await proxyRoute(c);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.agentPubkey).toBe(CHECKSUM);
    expect(getAddress(e.agentPubkey)).toBe(e.agentPubkey); // already checksummed
    expect(e.outcome).toBe('ok');
    expect(e.premiumLamports).toBe('500');
    expect(e.refundLamports).toBe('0');
    expect(typeof e.premiumLamports).toBe('string');
  });

  it('INV2(server_error): thrown inference → 502 path → premium+refund charged', async () => {
    const { events } = buildCtx({
      inferImpl: async () => {
        throw new Error('broker down');
      },
    });
    const { c } = fakeHono({
      verifiedAgent: CHECKSUM,
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const res = await proxyRoute(c);
    expect(res.status).toBe(502);
    expect(events[0].outcome).toBe('server_error');
    expect(events[0].premiumLamports).toBe('500');
    expect(events[0].refundLamports).toBe('5000');
  });

  it('INV2(latency_breach): demo pre-delay past SLA → latency_breach + refund', async () => {
    const { events } = buildCtx({ insecure: '1', slaMs: 5 });
    const { c } = fakeHono({
      verifiedAgent: CHECKSUM,
      query: { demo_breach: '1' },
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const res = await proxyRoute(c);
    expect(res.status).toBe(200);
    expect(events[0].outcome).toBe('latency_breach');
    expect(events[0].refundLamports).toBe('5000');
  });

  it('INV3: uninsured passthrough (no agent) — no event, no premium, still served', async () => {
    const { events, callInferenceWith } = buildCtx({});
    const { c } = fakeHono({ body: { messages: [{ role: 'user', content: 'hi' }] } });
    const res = await proxyRoute(c);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
    expect(callInferenceWith).toHaveBeenCalledOnce();
  });

  it('INV4: ?pact_wallet= → 401 unless PACT_PROXY_INSECURE_DEMO=1', async () => {
    buildCtx({ insecure: '0' });
    const blocked = fakeHono({
      query: { pact_wallet: LOWER_AGENT },
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const r1 = await proxyRoute(blocked.c);
    expect(r1.status).toBe(401);

    const { events } = buildCtx({ insecure: '1' });
    const ok = fakeHono({
      query: { pact_wallet: LOWER_AGENT },
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const r2 = await proxyRoute(ok.c);
    expect(r2.status).toBe(200);
    expect(events[0].agentPubkey).toBe(CHECKSUM); // normalised from lowercase query
  });

  it('5.D: messages from the body reach callInferenceWith', async () => {
    const { callInferenceWith } = buildCtx({});
    const msgs = [{ role: 'user', content: 'explain 0G' }];
    const { c } = fakeHono({ verifiedAgent: CHECKSUM, body: { messages: msgs } });
    await proxyRoute(c);
    expect(callInferenceWith).toHaveBeenCalledWith(
      expect.objectContaining({ messages: msgs, provider: PROVIDER, endpoint: 'https://compute/v1' }),
    );
  });

  it('400 when an insured call has no messages[]', async () => {
    buildCtx({});
    const { c } = fakeHono({ verifiedAgent: CHECKSUM, body: { foo: 1 } });
    const res = await proxyRoute(c);
    expect(res.status).toBe(400);
  });
});
