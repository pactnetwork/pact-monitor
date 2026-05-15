# @pact-network/settler-evm

NestJS service. Pact-0G settler — EVM port of [`@pact-network/settler`](../settler/).
Consumes `SettlementEvent`s off Pub/Sub, uploads per-call evidence to 0G
Storage, and submits `PactCore.settleBatch` on 0G Chain.

## Submission loop

```
consumer (Pub/Sub, ported verbatim)
  → batcher (EVM guards: drop sub-MIN premium / uint96 overflow / non-ASCII
             slug / non-EVM agent / bad callId; cross-batch settled-LRU dedup)
  → pipeline (STRICTLY SEQUENTIAL — one batch at a time)
      → submitter:
          1. clamp timestamp to (chain block.timestamp − 5s)
          2. pre-filter: getCallStatus(callId) ≠ Unsettled → ack + drop
          3. simulateContract (decodes the exact revert, no gas, no upload)
               • DuplicateCallId → re-query + reslice (≤2)
               • other revert    → nack (nothing uploaded)
          4. per event: writeEvidence(blob) → rootHash   (mutex-serialized)
          5. recordOrphans(settled:false)   ── BEFORE the tx
          6. settleBatch(records)           (mutex-serialized)
          7. waitForTransactionReceipt → status check (viem doesn't throw)
               • success  → markSettled + ack
               • reverted → markFailed  + nack
```

## Four review-driven decisions

1. **No indexer push.** `indexer-evm` reads `CallSettled`/`RecipientPaid`
   logs from chain directly. The settler never computes fee shares.
2. **Single-EOA nonce safety.** The ethers-based 0G Storage upload and the
   viem `settleBatch` sign with the same key. The pipeline is strictly
   sequential and a process-wide `SigningMutex` serializes every signed tx.
3. **`agentPubkey` is an EVM-address contract.** `@pact-network/wrap` types
   it as a free string. Pact-0G requires `market-proxy-zerog` to emit a 0x
   address there; anything else is ack+dropped at the batcher. Real on-chain
   e2e is therefore gated on the proxy (Week-2 milestone) — unit/integration
   tests use EVM-address fixtures.
4. **`DuplicateCallId` poison recovery.** PactCore reverts the whole batch on
   a dup. Defended by: batcher settled-LRU → submitter `getCallStatus`
   pre-filter → simulate-time requery + reslice.

## Orphan tracker

`FailedSettlement` rows are written (awaited) before the settle tx. On
receipt success they flip `settled:true`; on revert they keep `settled:false`
with the reason for manual GC. A crash after mine-but-before-DB leaves a
false orphan — acceptable, idempotent re-upload is content-addressed.

## Status

Bodies complete; unit/integration tested with mocked viem/ethers/Prisma
clients. Deferred: live anvil / real Pub/Sub e2e (Week-2), and a real
on-chain settle (gated on `market-proxy-zerog` emitting EVM agent addresses).

## Run

```bash
cp .env.example .env   # fill ZEROG_*, SETTLEMENT_AUTHORITY_KEY, PG_URL_ZEROG
pnpm --filter @pact-network/settler-evm test
pnpm --filter @pact-network/settler-evm build
pnpm --filter @pact-network/settler-evm start
```

## Reference

- [packages/settler/src/](../settler/src/) — the Solana original
- [packages/protocol-zerog-client/](../protocol-zerog-client/) — viem bindings
- Master plan §"Implementation step 3 — settler-evm submission loop"
