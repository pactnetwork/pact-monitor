# Pact Monitor — Demo Script

Live monitoring demo for hackathon presentations. Calls real Solana APIs through the Pact Monitor SDK and syncs results to the backend in real-time.

## Setup

```bash
cd samples/demo
cp .env.example .env
```

Edit `.env` with your Pact API key (generate with `pnpm run generate-key demo` from project root).

Optionally add Helius/QuickNode keys for more providers.

## Run

```bash
# Default: 5 rounds
pnpm tsx monitor.ts

# Custom rounds
pnpm tsx monitor.ts 10
```

Open the scorecard at http://localhost:5173 to see results appear live.
