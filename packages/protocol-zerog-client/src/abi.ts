/**
 * Typed ABI re-exports. The source is `src/generated/contracts.ts`, produced
 * by `pnpm generate` (@wagmi/cli foundry plugin) with `as const` so viem
 * keeps full literal-type inference. Never import the Foundry JSON directly —
 * that loses `as const` and degrades viem return types to `unknown`.
 *
 * `bindings.ts` imports from HERE and must not declare its own ABI const.
 */
export { pactCoreAbi, mockUsdcAbi, mockUsdcFaucetAbi } from './generated/contracts.js';
