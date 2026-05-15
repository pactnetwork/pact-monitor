import { describe, it, expect, vi } from 'vitest';
import { createErc20BalanceCheck } from '../src/balance';

const TOKEN = ('0x' + 'a'.repeat(40)) as `0x${string}`;
const SPENDER = ('0x' + 'b'.repeat(40)) as `0x${string}`;
const AGENT = '0x' + 'c'.repeat(40);

function mkClient(balance: bigint, allowance: bigint) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === 'balanceOf' ? balance : allowance,
  );
  return { publicClient: { readContract } as never, readContract };
}

describe('createErc20BalanceCheck', () => {
  it('eligible when balance and allowance both cover the premium', async () => {
    const { publicClient } = mkClient(1000n, 1000n);
    const bc = createErc20BalanceCheck({ publicClient, token: TOKEN, spender: SPENDER });
    const r = await bc.check(AGENT, 500n);
    expect(r).toEqual({ eligible: true, ataBalance: 1000n, allowance: 1000n });
  });

  it('insufficient_balance when balance < required', async () => {
    const { publicClient } = mkClient(100n, 1_000_000n);
    const bc = createErc20BalanceCheck({ publicClient, token: TOKEN, spender: SPENDER });
    const r = await bc.check(AGENT, 500n);
    expect(r).toMatchObject({ eligible: false, reason: 'insufficient_balance', ataBalance: 100n });
  });

  it('insufficient_allowance when balance ok but allowance short', async () => {
    const { publicClient } = mkClient(1000n, 10n);
    const bc = createErc20BalanceCheck({ publicClient, token: TOKEN, spender: SPENDER });
    const r = await bc.check(AGENT, 500n);
    expect(r).toMatchObject({ eligible: false, reason: 'insufficient_allowance', allowance: 10n });
  });

  it('queries balanceOf(agent) and allowance(agent, spender)', async () => {
    const { publicClient, readContract } = mkClient(1n, 1n);
    const bc = createErc20BalanceCheck({ publicClient, token: TOKEN, spender: SPENDER });
    await bc.check(AGENT, 1n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'balanceOf', args: [AGENT] }),
    );
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'allowance', args: [AGENT, SPENDER] }),
    );
  });
});
