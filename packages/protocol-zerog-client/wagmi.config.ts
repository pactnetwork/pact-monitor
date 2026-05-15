import { defineConfig } from '@wagmi/cli';
import { foundry } from '@wagmi/cli/plugins';

/**
 * Generates typed, `as const` ABIs from the Foundry artifacts so viem keeps
 * full literal-type inference. Plain JSON imports lose `as const` (viem docs),
 * which is why we codegen instead of importing `out/*.json` directly.
 *
 * `forge build` is run by the `prebuild`/`pretest` hooks in package.json,
 * so the plugin only reads artifacts here (forge.build = false).
 */
export default defineConfig({
  out: 'src/generated/contracts.ts',
  plugins: [
    foundry({
      project: '../protocol-zerog-contracts',
      forge: { build: false },
      include: [
        'PactCore.sol/**',
        'MockUsdc.sol/**',
        'MockUsdcFaucet.sol/**',
      ],
    }),
  ],
});
