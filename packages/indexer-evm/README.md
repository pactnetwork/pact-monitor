# @pact-network/indexer-evm

NestJS service. Pact-0G indexer — EVM port of [`@pact-network/indexer`](../indexer/).
Backfills + tails `PactCore` logs on 0G Chain via **viem**, hydrates
`@pact-network/db-zerog` Postgres, and serves the read API the dashboard
consumes. The settler does **not** push — this reads chain logs directly.

## Pipeline

```
LogReader (cursor loop, NOT watchEvent — crash-safe)
  getLogs(cursor+1 .. head, events:[8 PactCore events]); bisect on RPC limit
  → group by block, ascending, logIndex order
  → pre-tx: read evidence blob (latencyMs/breach), getFeeRecipients,
            getEndpointConfig, getBlock(ts)              [all network I/O here]
  → prisma.$transaction(applyBlock + cursor)             [NO network I/O]
  → page-end cursor advance (covers blocks with no logs)
Projection (per block, two-pass, idempotent):
  pass 1  config/pool/endpoint + CallSettled (Settlement per tx)
  pass 2  RecipientPaid (shares + earnings)
  end     delta-derived PoolState (Σpremium−ΣpaidOut−ΣactualRefund) + cursor
```

## Review-driven correctness (folded from 2 critique passes)

- **db-zerog reshaped** to match PactCore: Endpoint `flatPremiumWei/percentBps/imputedCostWei` (not `premiumPerCall/refundOnBreach`); `Call.refundWei = actualRefund` + `requestedRefundWei` (clamp gap) + nullable `latencyMs` + `breachReason`; `RecipientEarnings` re-keyed `@@id([endpointSlug,recipientAddress])`; new `FeeRecipient` + `IndexerCursor`; `PoolState.totalFeesPaidWei`; `SettlementRecipientShare` `@@unique([settlementTx,logIndex])`.
- **Idempotent:** every row insert guarded by a natural unique key; counters + pool deltas accumulate **only from rows that actually inserted**, so a replayed block is a no-op. Cursor advance is atomic with the block's writes.
- **breach** = evidence `breach`, else `status ∈ {PoolDepleted,ExposureCapClamped} || (Settled && actualRefund>0)`. `DelegateFailed` (premium 0) is never a breach. Verified against `_settleOne` for all 5 statuses.
- **`latencyMs`** from the 0G-Storage evidence blob; on read failure → `null`, ingest still commits (resilient).
- **Fee-recipient kind** is structural: Treasury iff the recipient is the endpoint's known Treasury, else Affiliate. As-of-head (documented hackathon limitation; archive-block read deferred).
- **No `watchEvent`** (silently misses logs / filter-support varies) — explicit persisted-cursor loop. 0G CometBFT BFT-final → no confirmation depth.

## Read API (parity minus ops)

`/api/stats` (5s cache, incl. `protocolPaused`, top-integrators grouped by
recipient), `/api/endpoints(/:slug)` (incl. live `feeRecipients`),
`/api/agents/:address(/calls)`, `/api/calls(?limit)(/:id)` (shares joined by
`call.txHash`), `/health` (cursor block), `/metrics`.

## Status

Bodies complete; unit-tested with mocked viem/Prisma/storage. Deferred
(Week-2): live 0G RPC / real Postgres e2e + `prisma migrate`.

## Run

```bash
cp .env.example .env
pnpm --filter @pact-network/indexer-evm test
pnpm --filter @pact-network/indexer-evm build
pnpm --filter @pact-network/indexer-evm start
```

## Reference

- [packages/indexer/src/](../indexer/src/) — the Solana original (read-API + idempotency reference)
- [packages/protocol-zerog-client/](../protocol-zerog-client/) — viem decoders/bindings
- Master plan §"Implementation step 4 — indexer-evm log reader + read API"
