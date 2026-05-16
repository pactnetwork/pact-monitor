# @pact-network/pact-zerog-dashboard

Single-page read-only dashboard for the Pact-0G hackathon submission. Pulls `CallSettled` events directly from `PactCore` on **0G Mainnet (Aristotle, chain 16661)** via viem — no indexer, no database, deploys as a static-ish Next.js app to Vercel.

## What it shows

- Protocol-state block: deployed `PactCore` address, premium token (USDC.e), latest block height
- Last 20 settled calls: block, endpoint slug, agent, status (`Settled` / `DelegateFailed` / `PoolDepleted` / `ExposureCapClamped`), premium, refund, 0G Storage evidence link, on-chain tx link

## Run locally

```bash
cp .env.example .env.local
# Set PACT_CORE_ADDRESS to the contract printed by the zerog-demo run
pnpm install
pnpm dev   # → http://localhost:3000
```

## Deploy to Vercel

1. Import the repo into Vercel, set the root to `packages/pact-zerog-dashboard`.
2. Env vars:
   - `PACT_CORE_ADDRESS` — deployed PactCore on Aristotle
   - `ZEROG_RPC_URL` — `https://evmrpc.0g.ai` (or a paid endpoint if rate-limited)
3. Deploy.

Page re-fetches on-chain state every 15 s (Next.js `revalidate = 15`). No client wallet needed; everything is server-side viem reads.

## Submission link

The deployed Vercel URL is what goes into the HackQuest submission's "Frontend demo link" field.

## Out of scope for the hackathon submission

The earlier skeleton planned wallet connect + a click-to-fire demo runner. Both got cut to ship by the deadline. The CLI at `samples/zerog-demo` drives the demo flow; this page shows the result.
