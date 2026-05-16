# Pact-0G end-to-end demo

End-to-end CLI for the [0G APAC Hackathon](https://www.hackquest.io/hackathons/0G-APAC-Hackathon) submission. Runs on **0G mainnet (Aristotle, chain 16661)** against the real [XSwap Bridged USDC.e](https://chainscan.0g.ai/address/0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E).

## What it does

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
