# @pact-network/indexer-evm

NestJS service. Pact-0G indexer — fork of [`@pact-network/indexer`](../indexer/).

## Status

🚧 **Skeleton only.** Week 2 work.

## What changes vs `@pact-network/indexer`

| Layer | Reuse strategy |
|---|---|
| Prisma schema | swap to `@pact-network/db-zerog` (EVM-shaped columns) |
| REST handlers | reuse — same shapes apart from `pubkey` → `address` |
| Backfill | new — `ethers.Contract.queryFilter('CallSettled', fromBlock, toBlock)` |
| Real-time | new — WS subscription on the same event filter |
| Account state hydration | swap PDA decodes → contract `view` calls (`getEndpointConfig`, `getCoveragePool`, etc.) |
| Storage hydration | new — `ZerogStorageClient.readEvidence(rootHash)` for the call-detail endpoint |

## Events to index

- `EndpointRegistered`
- `EndpointConfigUpdated`
- `FeeRecipientsUpdated`
- `PoolToppedUp`
- `CallSettled` ← the high-volume one
- `EndpointPaused` / `ProtocolPaused`

## REST endpoints

Mirror [`packages/indexer/`](../indexer/src/) — these stay the same shape:

- `GET /api/stats`
- `GET /api/endpoints`, `/api/endpoints/:slug`
- `GET /api/agents/:address`, `/api/agents/:address/calls?limit=N`
- `GET /api/calls/:callId` (hydrates evidence from 0G Storage)

## Idempotency

Use `(txHash, logIndex)` uniqueness from `db-zerog`'s `Call` model. Re-running backfill over a range that's partially written must not duplicate rows.
