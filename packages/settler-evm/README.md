# @pact-network/settler-evm

NestJS service. Pact-0G settler — fork of [`@pact-network/settler`](../settler/).

## Status

🚧 **Skeleton only.** Wire up Nest modules + submitter service in Week 2.

## What changes vs `@pact-network/settler`

| Layer | Reuse strategy |
|---|---|
| Pub/Sub event consumer | reuse as-is — chain-agnostic |
| Batcher / dedup / cache | reuse as-is — chain-agnostic |
| Endpoint config cache | swap PDA reads → `PactCoreClient.getEndpointConfig` |
| **Submitter** | full rewrite. Drop `buildSettleBatchIx` + `sendAndConfirmTransaction`. Use `PactCoreClient.settleBatch(records)` via ethers. |
| **Storage write** | NEW. For each event in the batch, upload the evidence blob via `ZerogStorageClient.writeEvidence` BEFORE building the on-chain tx. Carry `rootHash` into the record. |
| **Orphan tracker** | NEW. Write `FailedSettlement` row before submitting. On tx success, mark `settled=true`. On revert, the orphan blob is recoverable (idempotent via content addressing). |
| Authority key | swap PDA-signed settle → ECDSA wallet (`settlementAuthority` EOA) |

## Submission loop

```
for each batch from queue:
  1. for each SettlementEvent in batch:
       blob   = canonicalize({ callId, request_hash, status, latency_ms, ... })
       upload = await storage.writeEvidence(blob)        // → { rootHash, txHash, txSeq }
       db.failedSettlement.create({ callId, rootHash, attemptedAt: now })
       records.push({ ...event, rootHash: upload.rootHash })

  2. tx = await pactCore.settleBatch(records)           // 0G Chain
  3. on success: db.failedSettlement.markSettled(callId, txHash)
     on revert:  log + leave failedSettlement.settled=false
```

## Reference

- [packages/settler/src/](../settler/src/) — reuse the consumer/batcher/cache code
- [docs](../../docs/superpowers/specs/) — plan §"Off-chain stack & new packages"
