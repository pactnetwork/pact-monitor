# Pact-0G demo CLIs

Two CLIs for the [0G APAC Hackathon](https://www.hackquest.io/hackathons/0G-APAC-Hackathon) submission, both running on **0G mainnet (Aristotle, chain 16661)** against the real [XSwap Bridged USDC.e](https://chainscan.0g.ai/address/0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E):

- **`pact-0g`** (cli.ts) — agent-facing UX. Subcommands: `balance`, `approve`, `endpoint`, `pool`, `pay [--breach]`. Mirrors the shape of the Solana `pact pay` CLI. Use this for the demo video — it shows the protocol from an agent's perspective with balance deltas in human terms.
- **`pnpm demo`** (demo.ts) — protocol-side end-to-end. Reads balances, deploys/reuses PactCore, approves, registers an endpoint, tops up the coverage pool, settles two calls. Use this for first-time setup or to reproduce the full lifecycle from scratch.

## `pact-0g` CLI quickstart

```bash
pnpm pact-0g balance         # agent's $0G + USDC.e + allowance
pnpm pact-0g approve         # one-time: agent approves PactCore to debit USDC.e
pnpm pact-0g endpoint        # demo-chat config + lifetime stats
pnpm pact-0g pool            # coverage pool balance
pnpm pact-0g pay             # insured call, success path (agent: -premium)
pnpm pact-0g pay --breach    # insured call, breach path (agent: -premium +refund = ±0)
```

`pact-0g pay` is the moneymaker. Output shows the agent's USDC.e balance before and after the on-chain settle, the premium debited, the refund credited (if breach), and an insight line in human terms for the demo voice-over.

The CLI uses two wallets: an **agent** (holds USDC.e, signs `approve()`) and a **settler** (signs `settleBatch` on the agent's behalf). In production these are owned by different parties; for hackathon scope both private keys live in the same `.env`.

## `pnpm demo` — protocol lifecycle

One `tsx` invocation that prints, in order:

1. Deployer wallet address + native `$0G` balance + USDC.e balance
2. `PactCore.sol` deploy → contract address
3. USDC.e `approve(PactCore, type(uint256).max)`
4. `registerEndpoint("demo-chat", …)` — flat-premium endpoint
5. `topUpCoveragePool` — seeds the per-endpoint pool with USDC.e
6. `settleBatch` — one `SettlementRecord` for one fake call
7. **Submission artifacts block** with chainscan.0g.ai + storagescan.0g.ai links for every tx

## Run

```bash
cp .env.example .env
# Required: DEPLOYER_PK (the wallet must hold ~5 $0G for gas + ~1 USDC.e for the demo settle)
pnpm install
pnpm demo
```

`pnpm demo` runs `forge build` for `protocol-zerog-contracts` first, then `tsx demo.ts`.

## Funding the deployer

The wallet needs two assets on Aristotle:

| Asset | Amount | Source |
|---|---|---|
| `$0G` (native, for gas) | ~5 0G | Buy on Binance / Bybit / Kraken, withdraw to 0G Mainnet, paste the deployer address |
| USDC.e (premium token) | ~1 USDC.e | Bridge from Ethereum via [XSwap](https://xswap.link/bridge?toChain=16661) |

The demo only debits 0.01 USDC.e per call; ~0.5 USDC.e seeds the coverage pool. 1 USDC.e is comfortable for multiple runs.

## What gets submitted

When the demo prints the **Submission artifacts** block at the end, copy:

- `PactCore` address → into the HackQuest submission form's "0G mainnet contract address" field
- `settle_batch` tx hash → the "Explorer link with on-chain activity" proof
- 0G Storage rootHash → optional bonus, shows the evidence-blob layer
