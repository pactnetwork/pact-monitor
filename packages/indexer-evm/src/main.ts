/**
 * Pact-0G indexer entrypoint.
 *
 * Reuses the REST handlers + Prisma access patterns from @pact-network/indexer
 * (Solana). Only the chain reader is new:
 *   - ethers Contract.queryFilter(CallSettled, fromBlock, toBlock) for backfill
 *   - ethers WS subscription on the same filter for real-time
 *
 * STATUS: skeleton. Wire up Nest module + the chain-reader + REST handlers in Week 2.
 */

import 'reflect-metadata';

async function bootstrap(): Promise<void> {
  console.log('indexer-evm: not yet implemented — see packages/indexer/ for the Solana reference');
  process.exit(0);
}

bootstrap().catch((err) => { console.error(err); process.exit(1); });
