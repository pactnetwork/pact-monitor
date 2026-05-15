/**
 * Pact-0G settler entrypoint.
 *
 * Reuses the batcher / dedup / event-consumer layers from @pact-network/settler
 * (Solana). Only the submission path is new:
 *   1. ZerogStorageClient.writeEvidence(blob) → rootHash
 *   2. PactCoreClient.settleBatch(records[])  → 0G Chain tx
 *
 * STATUS: skeleton. Wire up Nest module + the submitter service from
 * packages/settler/src/submitter.service.ts patterns in Week 2.
 */

import 'reflect-metadata';

async function bootstrap(): Promise<void> {
  console.log('settler-evm: not yet implemented — see packages/settler/ for the Solana reference');
  process.exit(0);
}

bootstrap().catch((err) => { console.error(err); process.exit(1); });
