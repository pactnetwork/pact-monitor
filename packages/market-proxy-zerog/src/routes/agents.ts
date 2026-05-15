import type { Context } from 'hono';
import { getAddress, isAddress } from 'viem';
import { getContext } from '../context.js';

/** GET /v1/agents/:address — ERC20 balance + PactCore allowance snapshot. */
export async function agentsRoute(c: Context): Promise<Response> {
  const raw = c.req.param('address') ?? '';
  if (!isAddress(raw)) {
    return c.json({ error: 'invalid_address' }, 400);
  }
  const address = getAddress(raw);
  // `required: 1n` — just probe; eligibility for a real call depends on the
  // endpoint's premium, but this surfaces balance + allowance for the UI.
  const r = await getContext().balanceCheck.check(address, 1n);
  return c.json({
    address,
    usdcBalance: (r.ataBalance ?? 0n).toString(),
    allowance: (r.allowance ?? 0n).toString(),
    eligible: r.eligible,
  });
}
