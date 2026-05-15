# Pact-0G Day-0 / Day-1 spikes

Throwaway validation scripts for the four critical assumptions in
[../docs/superpowers/specs/pact-0g.md](../docs/superpowers/specs/pact-0g.md)
(plan at `~/.claude/plans/ok-great-lets-brainstorm-steady-stearns.md`).

If any spike fails, the plan changes shape before we scaffold packages. Run
all four before Day 2.

This directory lives **outside** the pnpm workspace
(`pnpm-workspace.yaml` only lists `packages/*`, `samples/demo`, and specific
`scripts/*`) — install each spike independently.

## Spikes

| # | Spike | What it proves | Status |
|---|---|---|---|
| 1 | [`foundry-bootstrap/`](./foundry-bootstrap/) | A no-op contract deploys to 0G via Foundry with `evm_version = cancun` (Galileo testnet by default, mainnet at Day 18) | pending |
| 2 | [`compute-broker/`](./compute-broker/) | `@0gfoundation/0g-compute-ts-sdk` round-trips: deposit → list provider → `getRequestHeaders()` → POST → `processResponse()` | pending |
| 3 | [`storage-sdk/`](./storage-sdk/) | `@0gfoundation/0g-storage-ts-sdk` uploads a blob via `Indexer.upload(MemData)` and returns `{ rootHash, txHash }` | pending |
| 4 | [`inft-erc7857/`](./inft-erc7857/) | An ERC-7857 reference contract is reachable and mints cleanly (or we know we need to write our own) | done — research-only |

## Workflow: testnet first, mainnet at submission

**Default for all spikes and Week-1/2 dev:** Galileo testnet (chain `16602`). Free, faucet-funded, same EVM shape as mainnet.

**Mainnet (chain `16661`):** used **only** for the Day-18 submission deploy of `PactCore`, `EndpointINFT`, `MockUsdc`, `MockUsdcFaucet` + one settled call to satisfy the explorer-link rule.

## Hard prerequisites (Day 0)

- Wallet funded via [faucet.0g.ai](https://faucet.0g.ai) on Galileo testnet. Backup faucet: [Google Cloud Web3 (0G/Galileo)](https://cloud.google.com/application/web3/faucet/0g/galileo). Pull enough drips for ~5–10 testnet 0G across all spikes.
- For Day-18 submission only: buy ~$10–20 of real `$0G` on Coinbase or Binance (network selector: `0G` / `Aristotle`). Mainnet faucet is **not** public.
- Provision a paid RPC endpoint (QuickNode / Ankr / ThirdWeb / dRPC) **after** spikes pass — public RPCs will rate-limit under demo load. Not needed for spike validation.

## 0G Chain facts

### Testnet — Galileo (spike + dev default)

```
CHAIN_ID=16602
RPC_URL=https://evmrpc-testnet.0g.ai
EXPLORER=https://chainscan-galileo.0g.ai
STORAGE_EXPLORER=https://storagescan-galileo.0g.ai
INDEXER_URL=https://indexer-storage-testnet-turbo.0g.ai
FAUCET=https://faucet.0g.ai
NATIVE_SYMBOL=0G
```

### Mainnet — Aristotle (submission gate only, Day 18)

```
CHAIN_ID=16661
RPC_URL=https://evmrpc.0g.ai
EXPLORER=https://chainscan.0g.ai
INDEXER_URL=https://indexer-storage-turbo.0g.ai
NATIVE_SYMBOL=0G
```

**Heads-up:** the Day-0 research report named SDK packages `@0glabs/0g-serving-broker` and `@0glabs/0g-ts-sdk` — both wrong. The published names per `docs.0g.ai` are `@0gfoundation/0g-compute-ts-sdk` and `@0gfoundation/0g-storage-ts-sdk` respectively. Spike scripts use the correct ones.

Sources verified by Day-0 web research:
- https://docs.0g.ai/developer-hub/testnet/testnet-overview
- https://docs.0g.ai/developer-hub/mainnet/mainnet-overview
- https://chainlist.org/chain/16661
- https://docs.0g.ai/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts

## Run order

Spikes 1, 2, 3 are independent — parallelize across the team. Spike 4 (INFT) is
already done (research-only).

After all three execution spikes come back green on testnet:
1. Amend the plan with any surface drift (SDK signatures, gas numbers, latency).
2. Start scaffolding the real packages in `packages/protocol-zerog-*` etc.
3. Move `spikes/` to `docs/superpowers/research/` (or delete) once Week-1 starts.
