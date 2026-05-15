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
| 1 | [`foundry-bootstrap/`](./foundry-bootstrap/) | A no-op contract deploys to 0G mainnet chain 16661 via Foundry with `evm_version = cancun` | pending |
| 2 | [`compute-broker/`](./compute-broker/) | `@0gfoundation/0g-compute-ts-sdk` round-trips: deposit → list provider → `getRequestHeaders()` → POST → `processResponse()` | pending |
| 3 | [`storage-sdk/`](./storage-sdk/) | `@0gfoundation/0g-storage-ts-sdk` uploads a blob via `Indexer.upload(MemData)` and returns `{ rootHash, txHash }` | pending |
| 4 | [`inft-erc7857/`](./inft-erc7857/) | An ERC-7857 reference contract is reachable and mints cleanly (or we know we need to write our own) | pending |

## Hard prerequisites (Day 0, in parallel)

- Funded mainnet wallet — buy `$0G` on Coinbase or Binance, withdraw to a fresh address. Budget $50–$100. Mainnet faucet is **not** public.
- Open a hackathon Discord ticket asking for a sponsor faucet (don't block on it; CEX is the reliable path).
- Provision a paid RPC endpoint (QuickNode / Ankr / ThirdWeb). Public `https://evmrpc.0g.ai` works for spikes but will rate-limit under demo load.

## 0G Chain facts (pin these in your shell or `.env`)

```
CHAIN_ID=16661
RPC_URL=https://evmrpc.0g.ai
EXPLORER=https://chainscan.0g.ai
NATIVE_SYMBOL=0G
```

**Heads-up:** the Day-0 research report named SDK packages `@0glabs/0g-serving-broker` and `@0glabs/0g-ts-sdk` — both wrong. The published names per `docs.0g.ai` are `@0gfoundation/0g-compute-ts-sdk` and `@0gfoundation/0g-storage-ts-sdk` respectively. Spike scripts use the correct ones.

Sources verified by Day-0 web research:
- https://docs.0g.ai/developer-hub/mainnet/mainnet-overview
- https://chainlist.org/chain/16661
- https://docs.0g.ai/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts

## Run order

Spikes 1, 2, 3 are independent — parallelize across the team. Spike 4 (INFT) can
also run in parallel but only blocks the Week 1 contract day for
`EndpointINFT.sol`, not the others.

After all four come back green, delete `spikes/` or move it under
`docs/superpowers/research/` for the historical record.
