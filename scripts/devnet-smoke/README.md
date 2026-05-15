# Devnet Smoke Harness

Post-deploy verification for the Railway-hosted devnet stack. Two phases:

1. **`health.sh`** — autonomous health probe. Curls the 3 public hostnames,
   confirms the indexer has chain-sync'd at least one endpoint, and (if
   `REDIS_URL` is exported) checks Redis Streams sanity. Safe to run as
   often as you want — no on-chain writes, no premium burn.

2. **10-call end-to-end smoke** — reuses the mainnet-smoke TypeScript
   harness under `scripts/mainnet-smoke/` with devnet env-var overrides.
   Burns ~$0.01 of devnet USDC (functionally free) and requires a funded
   devnet test agent keypair on disk.

## Phase 1 — Health probe (`health.sh`)

```sh
# Defaults: api-devnet/indexer-devnet/app-devnet.pactnetwork.io
./scripts/devnet-smoke/health.sh

# Override if you renamed services or are testing before DNS cuts over:
PROXY_URL=https://pact-market-proxy-production.up.railway.app \
INDEXER_URL=https://pact-indexer-production.up.railway.app \
DASHBOARD_URL=https://pact-market-dashboard-production.up.railway.app \
REDIS_URL=redis://default:pass@redis.railway.internal:6379 \
  ./scripts/devnet-smoke/health.sh
```

Pass criteria (per plan §8 lines 1–4 + 6):
- `/health` on proxy + indexer return `{"status":"ok"}`
- `/api/stats` on indexer returns JSON
- `/` on dashboard returns 200
- `/api/endpoints` on indexer includes `helius`
- (optional) Redis `XLEN pact-settle-events` is queryable; `XPENDING` < 100

Exits 0 if all checks pass, 1 otherwise.

## Phase 2 — 10-call end-to-end smoke

The mainnet smoke TypeScript harness is already parameterised by env vars;
we point it at devnet by overriding them. Note that several env names retain
their `MAINNET_*` prefix for historical reasons — the value is what
matters, not the name.

### Prerequisites

1. Phase 1 health probe passes.
2. On-chain init done on devnet (see `docs/devnet-railway-deploy.md` §6).
3. Test agent funded with ≥ 0.5 devnet USDC + ~0.01 devnet SOL.
4. `spl-token approve` run on the test agent ATA, delegating to the
   settlement-authority signer pubkey (see settler service env var
   `SETTLEMENT_AUTHORITY_KEY`).
5. Test agent keypair JSON on disk at `~/pact-devnet-keys/test-agent.json`
   (or wherever — set `TEST_AGENT_KEYPAIR_PATH` accordingly).

### Run

```sh
export MAINNET_RPC_URL="https://api.devnet.solana.com"  # cosmetic name, devnet value
export INDEXER_URL="https://indexer-devnet.pactnetwork.io"
export MARKET_PROXY_URL="https://api-devnet.pactnetwork.io"
export TEST_AGENT_KEYPAIR_PATH="~/pact-devnet-keys/test-agent.json"
export MAINNET_PROGRAM_ID="5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"
export USDC_MINT="Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"

pnpm tsx scripts/mainnet-smoke/00-preflight.ts
pnpm tsx scripts/mainnet-smoke/01-fire-10-calls.ts
pnpm tsx scripts/mainnet-smoke/02-reconcile.ts
```

Pass criteria (per plan §8 line 5):
- 10 `settle_batch` txs visible on Solana Explorer with `?cluster=devnet`
- Indexer `/api/stats`: `calls=10`, `premium=10000`, `pool=9000`, `treasury=1000`
- `GET /api/agents/<pubkey>/calls?limit=10` returns 10 rows (no 500 —
  this is the PR #113 regression check)

### Notes

- The mainnet-smoke harness has 5 endpoint slugs hard-coded
  (`helius / birdeye / jupiter / elfa / fal`). Devnet only registers
  `helius` initially, so `00-preflight.ts` will fail on the other 4. Two
  options: (a) edit `scripts/mainnet-smoke/lib/config.ts` to skip the
  others by env, or (b) accept the preflight failures on slugs we haven't
  registered yet and proceed to `01-fire-10-calls.ts` which only targets
  `helius`. Option (b) is simpler for the first devnet smoke.
- A dedicated `scripts/devnet-smoke/` TS harness is on the roadmap once
  the mainnet harness is generalised — for now we share the logic and
  override env vars.
