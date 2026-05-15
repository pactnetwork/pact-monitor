# @pact-network/zerog-storage-client

Node-only typed wrapper over [`@0gfoundation/0g-storage-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-storage-ts-sdk) (v1.2.9).

## Status

✅ **Implementation matches validated surface from [spikes/storage-sdk](../../spikes/storage-sdk/).**

## API

```ts
import { ZerogStorageClient, GALILEO_TESTNET, computeRootHash } from '@pact-network/zerog-storage-client';

const client = new ZerogStorageClient(GALILEO_TESTNET, process.env.PRIVATE_KEY!);

// upload
const blob = new TextEncoder().encode(JSON.stringify({ callId, latency_ms, ... }));
const { rootHash, txHash, txSeq } = await client.writeEvidence(blob);

// download
const bytes = await client.readEvidence(rootHash);

// pre-compute hash without uploading (idempotency key for orphan tracking)
const hash = await computeRootHash(blob);
```

## Notes

- **Node-only.** The SDK uses `fs.appendFileSync` in `download()`. Do not import into Next.js client bundles.
- **Determinism.** Same bytes → same `rootHash`. Spike 3 confirmed this is server-stable, so the settler can retry a failed `settleBatch` with the same evidence and the storage upload deduplicates.
- **Upload return shape.** Includes `txSeq` alongside `{ rootHash, txHash }`. The original Day-0 research missed this field; surface it because the indexer may key off it.
- **Cost.** ~61 µ0G per 334-byte blob on Galileo testnet (spike 3). Negligible at hackathon scale.
- **Latency.** ~14s upload (dominated by storage-node sync wait), ~1.5s download. Settler should queue, not block.

## Network presets

- `GALILEO_TESTNET` — chain 16602, validated by spike 3
- `ARISTOTLE_MAINNET` — chain 16661, not yet validated (Day 18 task)
