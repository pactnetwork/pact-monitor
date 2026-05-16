import type { PublicClient } from 'viem';
import { mockUsdcAbi } from '@pact-network/protocol-zerog-client';
import type { BalanceCheck, BalanceCheckResult } from '@pact-network/wrap';

/**
 * EVM substitute for wrap's Solana SPL `BalanceCheck`. Settlement debits the
 * agent via `PactCore.settleBatch` → `IERC20(usdc).transferFrom(agent, …)`,
 * where `usdc` is `MockUsdc` on Galileo testnet or the XSwap Bridged USDC.e
 * (0x1f3aA82227281Ca364bfb3D253b0F1af1da6473e) on Aristotle mainnet. Both
 * conform to the ERC-20 ABI exposed by `mockUsdcAbi`, so the same balance/
 * allowance check works in either mode.
 *
 * A call is only insurable if the agent BOTH holds the premium AND has approved
 * `PactCore` (the spender) for at least it. wrap calls this with
 * `required = endpointConfig.flat_premium_lamports` (the Wei premium);
 * refunds come from the pool, never the agent, so premium-only is correct
 * (mirrors wrap's own preflight rationale).
 *
 * `BalanceCheckResult` field names (`ataBalance`/`allowance`) are wrap's
 * Solana-era vocabulary; here `ataBalance` carries `balanceOf` and
 * `allowance` carries the ERC20 allowance.
 */
export function createErc20BalanceCheck(opts: {
  publicClient: PublicClient;
  token: `0x${string}`;
  spender: `0x${string}`;
}): BalanceCheck {
  const { publicClient, token, spender } = opts;
  return {
    async check(
      walletPubkey: string,
      required: bigint,
    ): Promise<BalanceCheckResult> {
      const agent = walletPubkey as `0x${string}`;
      const [balance, allowance] = (await Promise.all([
        publicClient.readContract({
          address: token,
          abi: mockUsdcAbi,
          functionName: 'balanceOf',
          args: [agent],
        }),
        publicClient.readContract({
          address: token,
          abi: mockUsdcAbi,
          functionName: 'allowance',
          args: [agent, spender],
        }),
      ])) as [bigint, bigint];

      if (balance < required) {
        return {
          eligible: false,
          reason: 'insufficient_balance',
          ataBalance: balance,
          allowance,
        };
      }
      if (allowance < required) {
        return {
          eligible: false,
          reason: 'insufficient_allowance',
          ataBalance: balance,
          allowance,
        };
      }
      return { eligible: true, ataBalance: balance, allowance };
    },
  };
}
