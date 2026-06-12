# Pact Network — Arbitrum Sepolia deployment

Full-stack Pact deployment on **Arbitrum Sepolia** (chainId **421614**) for the
**Arbitrum Open House London — Online Buildathon** (Agentic AI track). Pact is
on-chain insurance for AI-agent API calls: a coverage pool debits a small
premium per call and refunds the agent automatically when the call breaches an
SLA (5xx / network error / latency) — every settlement on-chain with explicit
per-recipient fee splits.

The EVM stack is generic and chain-agnostic; Arbitrum Sepolia is a new chain
entry + a new deployment of the existing contracts/services — no forked code.

## Deployed contracts (Arbitrum Sepolia, chainId 421614)

| Contract | Address | Arbiscan |
|----------|---------|----------|
| PactRegistry | `0x79A91E5965094266d221Aaef8E66d6C364819edb` | https://sepolia.arbiscan.io/address/0x79A91E5965094266d221Aaef8E66d6C364819edb |
| PactPool | `0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc` | https://sepolia.arbiscan.io/address/0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc |
| PactSettler | `0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043` | https://sepolia.arbiscan.io/address/0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043 |

- **USDC (Circle test):** `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (6 decimals; confirmed on-chain `symbol()=USDC`, `decimals()=6`)
- **Deploy block:** `276425280`
- **Deploy tx (PactRegistry):** `0x1034450c958fcaa7932e6c3133d30c078681c17a63c032deeae09db60c837817`
- **Deployer/authority (permanent):** `0xFaFE88B744B53e66CD2896E77EAB3De0D9Ab3f53`
- **Treasury vault (permanent, no setter):** `0x130bcfAd4d405dB3EF296B76a052180bB5a9c176`
- **Arbiscan source verification:** ✅ all 3 verified (Etherscan V2; see Verification below)

`SETTLER_ROLE` granted to the PactSettler **contract** on Registry+Pool (by Deploy.s.sol),
and to the off-chain **settler EOA** `0x232132df53665D3E6987E40Bab6Ee59E0d043822`
(tx `0xe3d7852b57ff827258672ed6bd88f789cc068caaf9e64b237ae9b1e52c9120b5`).

## EOAs (fresh testnet keys — private keys in `~/.pact-keys/arbitrum-sepolia/*.key`, chmod 600, never committed)

| Role | Address |
|------|---------|
| deployer / authority (permanent) | `0xFaFE88B744B53e66CD2896E77EAB3De0D9Ab3f53` |
| off-chain settler signer | `0x232132df53665D3E6987E40Bab6Ee59E0d043822` |
| treasury vault (permanent) | `0x130bcfAd4d405dB3EF296B76a052180bB5a9c176` |
| insured agent | `0xaeC07b96123715D434C212B41AFdd73f4DDA29c4` |

## Chain registry entry

Added `arbitrum-sepolia` to the three sync points (drift-tested by CI):
- `packages/program-evm/protocol-evm-v1/config/chains.json` (canonical)
- `packages/shared/src/chains.ts` (`_evmChains`)
- `packages/protocol-evm-v1-client/src/constants.ts` (`_chainsJson` + `ARBITRUM_SEPOLIA_*` exports)

Plus the deployment addresses in `packages/protocol-evm-v1-client/src/addresses.ts`
`DEPLOYMENTS[421614]`. Params: `blockTimeMs:2000, finalityBlocks:1,
finalityBlockTag:"safe", logRangeChunk:1000, deploymentBlock:276425280`.

> Note: Arbitrum Sepolia `safe` block tag lags `latest` by ~2,400 blocks (~10 min);
> `finalized` ~16 min. Settle **confirmation** uses `latest` (fast). Indexer/dashboard
> reflection is bounded by the `safe` tag, so on-chain actions surface in the
> dashboard ~10 min later. Sequence demo captures accordingly.

## Deploy command

```bash
cd packages/program-evm/protocol-evm-v1
DEPLOYER_PRIVATE_KEY=$(cat ~/.pact-keys/arbitrum-sepolia/deployer.key) \
TREASURY_VAULT_ADDRESS=0x130bcfAd4d405dB3EF296B76a052180bB5a9c176 \
CHAIN_ID=421614 \
forge script script/Deploy.s.sol --rpc-url https://sepolia-rollup.arbitrum.io/rpc --broadcast
```
Deploys PactRegistry -> PactPool -> PactSettler, grants SETTLER_ROLE to the settler contract.

## Verification (Arbiscan) — DONE

All 3 verified via the **Etherscan V2** unified API (the key is an Etherscan V2
key; the Arbiscan V1 endpoint is deprecated). `forge verify-contract` with
`--chain 421614` (no `--verifier-url`) routes to V2 automatically. Constructor
args come from `broadcast/Deploy.s.sol/421614/run-latest.json`.

```bash
source ~/.pact-keys/arbitrum-sepolia/verify.env   # ARBISCAN_API_KEY (Etherscan V2 key)
cd packages/program-evm/protocol-evm-v1
forge verify-contract 0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc src/PactPool.sol:PactPool \
  --chain 421614 --etherscan-api-key "$ARBISCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d 0x79A91E5965094266d221Aaef8E66d6C364819edb) --watch
# PactSettler: constructor(address,address,address) usdc registry pool
# PactRegistry: constructor(address,address,address,uint16,(uint8,address,uint16)[8],uint8)
#   deployer usdc treasury 3000 [8x zero-tuple] 0
```

## Local service stack (run against the live RPC; no Cloud Run needed)

Infra: `docker run` Postgres 16 (`PG_URL=postgresql://pact:pact@localhost:5432/pact`,
`pnpm --filter @pact-network/db db:migrate`) + Redis 7 (`redis://localhost:6379`).
Build deps once: `pnpm --filter "@pact-network/indexer^..." --filter "@pact-network/settler^..." --filter "@pact-network/market-proxy^..." build`.

| Service | Port | Start |
|---------|------|-------|
| dummy-upstream | 8090 | `PORT=8090 pnpm dev` (breach toggles `?fail=1`/`?status=`/`?latency=`) |
| indexer | 3101 | `PG_URL=... PACT_ENABLED_NETWORKS=arbitrum-sepolia INDEXER_PUSH_SECRET=localdev-secret PORT=3101 pnpm start` |
| settler | 8082 | `PACT_ENABLED_NETWORKS=arbitrum-sepolia QUEUE_BACKEND=redis-streams REDIS_URL=... REDIS_STREAM=pact-settle-events INDEXER_URL=http://localhost:3101 INDEXER_PUSH_SECRET=localdev-secret PACT_RPC_URL_ARBITRUM_SEPOLIA=https://sepolia-rollup.arbitrum.io/rpc PACT_SETTLER_KEYPAIR_ARBITRUM_SEPOLIA=$(cat ~/.pact-keys/arbitrum-sepolia/settler.key) PORT=8082 pnpm start` |
| market-proxy | 8080 | `PG_URL=... PACT_ENABLED_NETWORKS=arbitrum-sepolia QUEUE_BACKEND=redis-streams REDIS_URL=... REDIS_STREAM=pact-settle-events ENDPOINTS_RELOAD_TOKEN=... PORT=8080 pnpm start` (build first) |
| market-dashboard | 3100 | `NEXT_PUBLIC_INDEXER_URL=http://localhost:3101 PORT=3100 pnpm dev` |

> Dashboard caveat: wallet + on-chain reads are Solana-only; the read-only
> stats/endpoints/calls panes render the Arbitrum data from the indexer, but the
> interactive "approve allowance" flow is Solana-only — the agent USDC approve is
> done via `cast` (below).

## Endpoint registered (on-chain)

slug `dummy`, network `arbitrum-sepolia`: flatPremium 1000 (=$0.001), percentBps 0,
slaLatencyMs 2000, imputedCost 10000 (=$0.01), exposureCapPerHour 1000000, fee
split treasury 10% (1000 bps). On-chain tx
`0xb02bbebb2b9a9c082a6bda0e24aa9019c122034fa6b64ab53899d73da52afabb` (block 276428586).

## E2E: insured call -> SLA breach -> on-chain refund (the proof)

```bash
RPC=https://sepolia-rollup.arbitrum.io/rpc
USDC=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
POOL=0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc
SETTLER=0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043
SLUG=0x64756d6d790000000000000000000000   # slugToBytes16("dummy")
DK=$(cat ~/.pact-keys/arbitrum-sepolia/deployer.key)
AK=$(cat ~/.pact-keys/arbitrum-sepolia/agent.key)
AGENT=0xaeC07b96123715D434C212B41AFdd73f4DDA29c4
# 1. fund pool (deployer): approve + topUp 1 USDC
cast send $USDC "approve(address,uint256)" $POOL 1000000 --rpc-url $RPC --private-key $DK
cast send $POOL "topUp(bytes16,uint256)" $SLUG 1000000 --rpc-url $RPC --private-key $DK
# 2. give agent USDC + approve settler to debit premium
cast send $USDC "transfer(address,uint256)" $AGENT 1000000 --rpc-url $RPC --private-key $DK
cast send $USDC "approve(address,uint256)" $SETTLER 1000000 --rpc-url $RPC --private-key $AK
# 3. insured call with forced 5xx breach (through the proxy)
curl -si "http://localhost:8080/v1/dummy/anything?fail=1" -H "x-pact-network: arbitrum-sepolia" -H "x-pact-agent: $AGENT"
# 4. settler picks up the breach event -> settleBatch on-chain -> refund. Capture tx on sepolia.arbiscan.io
```

- **Settle tx (refund on Arbitrum Sepolia):** _TBD — captured during E2E run_

## Submission artifacts

- Deployed contract (Arbitrum Sepolia): PactRegistry `0x79A91E5965094266d221Aaef8E66d6C364819edb`
- Public repo: this repo, branch `feat/arbitrum-sepolia-deploy` -> PR to `develop`
- Dashboard: local `http://localhost:3100` (read-only Arbitrum panes)
- Settle tx (insured-call breach refund): _TBD_
- Demo video + writeup: _TBD_

## Cleanup

- Return surplus testnet ETH from deployer/settler/agent back to the funding source after the demo.
