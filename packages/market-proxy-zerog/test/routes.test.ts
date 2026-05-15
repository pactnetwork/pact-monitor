import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAddress } from 'viem';
import { agentsRoute } from '../src/routes/agents';
import { healthRoute } from '../src/routes/health';
import { setContextForTest, type AppContext } from '../src/context';
import { DEFAULT_PROVIDERS } from '../src/endpoints';

const LOWER = '0x' + 'b'.repeat(40);
const CHECKSUM = getAddress(LOWER);

function fakeC(param?: string) {
  let json: { obj: unknown; status: number } | null = null;
  const c = {
    req: { param: () => param },
    json: (obj: unknown, status = 200) => {
      json = { obj, status };
      return new Response(JSON.stringify(obj), { status });
    },
  };
  return { c: c as never, get: () => json };
}

afterEach(() => setContextForTest(null));

describe('healthRoute', () => {
  it('returns ok + served slugs', () => {
    const { c, get } = fakeC();
    healthRoute(c);
    expect(get()?.obj).toEqual({
      status: 'ok',
      version: 'v1',
      endpoints: Object.keys(DEFAULT_PROVIDERS),
    });
  });
});

describe('agentsRoute', () => {
  it('400 on a non-EVM address', async () => {
    const { c, get } = fakeC('not-an-addr');
    await agentsRoute(c);
    expect(get()?.status).toBe(400);
  });

  it('returns balance/allowance/eligible for a checksummed address', async () => {
    const check = vi.fn(async () => ({ eligible: true, ataBalance: 1234n, allowance: 99n }));
    setContextForTest({ balanceCheck: { check } } as unknown as AppContext);
    const { c, get } = fakeC(LOWER);
    await agentsRoute(c);
    expect(check).toHaveBeenCalledWith(CHECKSUM, 1n);
    expect(get()?.obj).toEqual({
      address: CHECKSUM,
      usdcBalance: '1234',
      allowance: '99',
      eligible: true,
    });
  });
});
