# Spike 3 — 0G Storage round-trip

**Proves:** `@0gfoundation/0g-storage-ts-sdk` can upload an evidence blob to 0G mainnet, return a deterministic `rootHash`, and round-trip the bytes back via `download(rootHash)`.

**Why this matters:** Per-call evidence is one of the three claimed 0G integrations. The plan's orphan-blob retry strategy assumes content-addressed determinism — same blob → same `rootHash`. This spike asserts that.

## Prereqs

- Node 22+, pnpm
- Wallet funded with testnet 0G from [faucet.0g.ai](https://faucet.0g.ai) (small amount — Storage charges by blob size + a flow fee)
- Default targets Galileo testnet. For mainnet validation, swap URLs in `.env`.

## Endpoints

| | Testnet (default) | Mainnet (Day 18 only) |
|---|---|---|
| RPC | `https://evmrpc-testnet.0g.ai` | `https://evmrpc.0g.ai` |
| Storage Indexer (turbo) | `https://indexer-storage-testnet-turbo.0g.ai` | `https://indexer-storage-turbo.0g.ai` |
| Explorer | `https://chainscan-galileo.0g.ai` | `https://chainscan.0g.ai` |
| Storage Explorer | `https://storagescan-galileo.0g.ai` | (none documented yet) |

Sources:
- https://docs.0g.ai/developer-hub/testnet/testnet-overview
- https://docs.0g.ai/developer-hub/mainnet/mainnet-overview

## Run

```bash
cd spikes/storage-sdk
pnpm install
cp .env.example .env
# edit .env: PRIVATE_KEY

pnpm spike
```

## Pass criteria

- Two `merkleTree()` calls on the same blob produce **identical** `rootHash` (the determinism gate).
- `indexer.upload()` returns a tx hash that resolves on `chainscan.0g.ai`.
- `indexer.download(rootHash, …)` returns the original blob byte-for-byte.
- Final summary prints `rootHash`, upload latency, download latency. These numbers calibrate the settler's per-call cost envelope.

## Fail signals worth noting

- `rootHash` non-deterministic → orphan-blob retry strategy in the plan needs redesign. Switch to recording `(callId → rootHash)` mapping in the settler DB before each upload, and de-orphan via that lookup.
- `upload()` returns error about insufficient flow balance → fund + retry. Note the gas + flow fee per blob; if it's larger than expected, consider batching evidence per settlement batch.
- `download()` fails for `> 30s` even though `upload` succeeded → propagation lag; document the lag.
- SDK throws on import (e.g. `fs` not found in CJS) → check that the SDK is being loaded in Node mode; the plan already states "Node-only, never import into the Next.js client bundle."

## What to record back

In `spikes/inft-erc7857/RESULTS.md` (or its sibling), capture:

- Upload tx hash + explorer link (proves the round-trip happened on mainnet)
- Round-trip latency: upload ms, download ms
- The mainnet `rootHash` (we'll use it as a fixture in `zerog-storage-client` tests)
- Approximate `0G` cost per kB written (calculate from tx receipt gas + flow fee)

## Surface differences from the original Day-0 research

The research agent reported:
- Wrong package: `@0glabs/0g-ts-sdk` → actual is `@0gfoundation/0g-storage-ts-sdk`
- Reported upload shape `{ rootHash, txHash }` — docs confirm this for files <4GB. Verify in the spike output.
- The flow uses `MemData` + `Indexer.upload()`, not `ZgFile`. `ZgFile` is the file-system variant.
