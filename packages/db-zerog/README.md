# @pact-network/db-zerog

Prisma schema for the Pact-0G indexer. Forked from [`@pact-network/db`](../db/).

## Why forked

The Solana schema uses Solana-shaped columns (44-char base58 pubkeys, 88-char tx signatures, "lamports" amounts). The 0G schema uses EVM shapes (42-char 0x addresses, 66-char tx hashes, "wei" amounts) plus a 0G-specific `evidenceRootHash` column for storage CIDs.

The original plan said "reuse db as-is" but the critique correctly flagged this as fragile. We fork instead — two schemas, two databases (`PG_URL` vs `PG_URL_ZEROG`).

## Models

| Model | Notes |
|---|---|
| `Endpoint` | slug → INFT tokenId + premium/refund/SLO + upstream model |
| `Agent` | EVM address, lifetime stats |
| `Call` | one per `CallSettled` event. Keyed by `callId`, also indexed by `(txHash, logIndex)` |
| `Settlement` | batched tx-level rollup |
| `SettlementRecipientShare` | per-recipient fee outflow within a batch |
| `PoolState` | per-endpoint pool balance + lifetime sums |
| `RecipientEarnings` | lifetime earnings per fee recipient |
| `FailedSettlement` | orphan-blob tracker — see plan §"orphan blob handling" |

## Setup

```bash
cp .env.example .env  # set PG_URL_ZEROG
pnpm db:migrate:dev
```
