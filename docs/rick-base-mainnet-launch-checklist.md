# Rick — Base Mainnet EVM Launch Checklist

**Scope:** launch the EVM path on **Base mainnet** (chain `8453`) only. NO Solana work in this pass (no mainnet provider re-register, no devnet redeploy, no FS9/SOL-01). Today EVM is testnet-only (Arc Testnet + Base Sepolia); this takes it to one production EVM chain.

**Owner split:** all on-chain mainnet deploys, Secret Manager, Cloud Run, IAM, and the deployer/authority keys are Rick's (Tu has no mainnet keys / GCP access). The two CODE follow-ups in §6 are Tu's.

**Source of truth for facts below:** `packages/program-evm/protocol-evm-v1/script/Deploy.s.sol`, `config/chains.json`, `packages/protocol-evm-v1-client/src/{addresses.ts,constants.ts}`, `.planning/endpoint-registration-plan.md` §A.2.

---

## Base mainnet constants (already in `chains.json`, verified)
- chainId: `8453`
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)
- public RPC: `https://mainnet.base.org` (use a **paid** RPC for the settler/indexer — see §5)
- **Gas = ETH** (Base is NOT USDC-native gas, unlike Arc — the settler EOA must hold ETH)
- `deploymentBlock`: `null` → contracts not deployed yet (this checklist fills it)

---

## STEP 0 — DECIDE first (4 product/ops calls, blocks everything)
1. **Deployer / authority EOA** — which key deploys + becomes protocol authority (admin over roles, registration, treasury). On testnets this was `0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859`. For mainnet, pick the key and plan a **post-deploy authority rotation to a multisig** (the deploy script intentionally has no separate-authority branch — authority == deployer at ctor; rotating is a later transfer step).
2. **Treasury vault address** (`TREASURY_VAULT_ADDRESS`) — receives the network fee cut.
3. **Which provider slugs to insure on Base mainnet** (e.g. dummy first, then helius/jupiter/birdeye/…). Each is a separate `registerEndpoint`.
4. **Per-endpoint product values** — `flatPremium`, `percentBps`, `slaLatencyMs`, `imputedCost`, `exposureCapPerHour`, and explicit `feeRecipients` split (protocol default is EMPTY — every endpoint must carry its own).

---

## STEP 1 — Deploy the 3-contract suite to Base mainnet
From `packages/program-evm/protocol-evm-v1/`:

```bash
export DEPLOYER_PRIVATE_KEY=0x...          # the §0.1 deployer EOA (holds ETH for gas)
export TREASURY_VAULT_ADDRESS=0x...        # the §0.2 treasury
export CHAIN_ID=8453

forge script script/Deploy.s.sol \
  --rpc-url https://mainnet.base.org \
  --broadcast \
  --verify --etherscan-api-key $BASESCAN_API_KEY
```

Deploys, in order: **PactRegistry** → **PactPool** → **PactSettler**, then grants SETTLER_ROLE to the *settler contract* on Registry + Pool (Deploy.s.sol:108-119).

**Record the 3 printed addresses** (`PactRegistry`, `PactPool`, `PactSettler`) and the **deploy block number**. NOTE: Base-mainnet addresses will be **DIFFERENT** from the testnet ones (different deployer/nonce) — do not reuse the `0x056b…/0xa613…/0xe461…` testnet addresses.

---

## STEP 2 — Grant SETTLER_ROLE to the OFF-CHAIN settler EOA (critical, not in Deploy)
`settleBatch` is `onlyRole(SETTLER_ROLE)` on **PactSettler**, and the off-chain settler key isn't known at deploy — so Deploy does NOT grant it. The off-chain settler will revert on every batch until you run this from the **authority** key:

```bash
cast send <PactSettler_addr> \
  "grantRole(bytes32,address)" \
  $(cast keccak "SETTLER_ROLE") <OFF_CHAIN_SETTLER_EOA> \
  --rpc-url https://mainnet.base.org \
  --private-key $AUTHORITY_PRIVATE_KEY
```

`<OFF_CHAIN_SETTLER_EOA>` = the address of the key you'll put in Secret Manager as `PACT_SETTLER_KEYPAIR_BASE_MAINNET` (§5).

---

## STEP 3 — Register endpoints on-chain (per chosen provider)
Via the **registry authority** key, encode with `encodeRegisterEndpoint` (ABI `packages/protocol-evm-v1-client/src/abi/PactRegistry.ts`; shape in `.planning/endpoint-registration-plan.md` §A.2):

```
registerEndpoint(slug, flatPremium, percentBps, slaLatencyMs,
                 imputedCost, exposureCapPerHour, feeRecipients[], paused=false)
```

Repeat per slug from §0.3 with the values from §0.4. USDC amounts are 6-dp base units (`1000` = $0.001/call).

---

## STEP 4 — DB (Cloud SQL Postgres)
1. `prisma migrate deploy` on the prod DB (multi-network schema: `Endpoint` composite key `(network, slug)` + per-network sync cursor) if not already applied.
2. After the indexer (§5) syncs, the `Endpoint` rows for base-mainnet **auto-materialize** on the 5-min `OnChainSyncService` tick — no manual row writes.
3. Hot-reload the proxy cache: `POST /admin/reload-endpoints` with `Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN`.

---

## STEP 5 — Cloud Run + Secret Manager
Exact var names (verified in `packages/settler/src/config/env.ts` + `packages/indexer`). Set on **settler + indexer + proxy** unless noted.
1. **`PACT_ENABLED_NETWORKS`** — append `base-mainnet` to the existing list.
2. **`PACT_RPC_URL_BASE_MAINNET`** → a **paid** Base RPC (Alchemy/QuickNode/…), not `mainnet.base.org`. Needed by BOTH settler (write `eth_sendRawTransaction`) and indexer (log reads).
3. **`PACT_SETTLER_KEYPAIR_BASE_MAINNET`** (0x-hex) in Secret Manager = the §2 off-chain settler EOA (settler only).
4. **`PACT_EVM_GAS_WARN_WEI_BASE_MAINNET`** (optional) — low-ETH warning threshold for the settler signer (there's already one for arc-testnet).
5. **Fund the settler EOA with ETH** on Base (gas — Base is not USDC-gas). Start small, watch the balance.
6. **`ENDPOINTS_RELOAD_TOKEN`** (≥16 chars) for the proxy admin route (if not already set).
7. **Rebuild prod images from current `feat/multi-network`** so the PR #225 P0-1 Dockerfile fix (copies `@pact-network/shared` + `@pact-network/protocol-evm-v1-client`) is in.

**No new queue infra.** Prod runs `QUEUE_BACKEND=pubsub` with a single network-agnostic `PUBSUB_SUBSCRIPTION` — base-mainnet settle jobs flow through the existing topic/subscription. **Do NOT** create a per-network Pub/Sub topic. (`PUBSUB_PROJECT`/`PUBSUB_SUBSCRIPTION` and the existing `SOLANA_RPC_URL` stay as-is — the settler env schema still requires `SOLANA_RPC_URL` to boot even though this pass touches no Solana.)

---

## STEP 6 — Wire the deployed addresses back into the repo (CODE, needs §1+§2 outputs)
Rick reports the §1/§2 values (see the **Deployment Record** at the bottom); the edits below are a tiny commit (Tu can land it from the reported values, or Rick if he has the checkout). **Services cannot index or settle base-mainnet until these land and prod rebuilds.**
1. Add a **`base-mainnet` block to `packages/protocol-evm-v1-client/src/addresses.ts`** (`registry`/`pool`/`settler` from §1) — currently only arc-testnet + base-sepolia exist.
2. **HARD DEPENDENCY:** set **`config/chains.json` → `base-mainnet.deploymentBlock`** to the §1 deploy block. The indexer reads this to know where to start EVM log backfill — if left `null`, base-mainnet indexing does not start.
3. Verify `base-mainnet` is an accepted network value across `shared` (no hardcoded testnet-only enum). Then rebuild/redeploy services (loops back to §5.7).

---

## STEP 7 — Verify live
1. `GET /api/endpoints` (indexer) shows the base-mainnet endpoints with synced config.
2. Run **one real settle** through the prod settler: a funded agent (USDC on Base + `approve` to the Pool) makes an insured call via the proxy; confirm premium debit on success and **refund/payout on a forced breach**, on-chain.
3. Confirm the settler EOA's ETH balance didn't run dry mid-batch.

---

## Suggested order
0 (decide) → 1 (deploy) → 2 (grant settler role) → 6 (record addresses) → 5 (services) → 3 (register endpoints) → 4 (DB auto-sync) → 7 (verify).

---

## DEPLOYMENT RECORD — fill in and hand back
Everything the rest of the wiring needs. Capture as you go and return this block.

**Step 0 decisions**
- Deployer / authority EOA: `0x____________________`
- Authority rotation target (multisig), if any: `0x____________________`
- Treasury vault (`TREASURY_VAULT_ADDRESS`): `0x____________________`
- Off-chain settler EOA: `0x____________________`

**Step 1 deploy outputs (Base mainnet, chainId 8453)**
- PactRegistry: `0x____________________`
- PactPool:     `0x____________________`
- PactSettler:  `0x____________________`
- Deploy block number: `____________`
- Deploy tx hash: `0x____________________`
- Basescan verification links (Registry/Pool/Settler): `____________`

**Step 2 role grant**
- `grantRole(SETTLER_ROLE, <settler EOA>)` on PactSettler — tx hash: `0x____________________`

**Step 3 endpoint registrations** (one row per provider)
| slug | flatPremium | percentBps | slaLatencyMs | imputedCost | exposureCapPerHour | feeRecipients (addr:bps …) | register tx |
|------|-------------|-----------|--------------|-------------|--------------------|----------------------------|-------------|
|      |             |           |              |             |                    |                            |             |

**Step 5 ops confirmations**
- Settler EOA ETH funded — tx hash / balance: `____________`
- `PACT_ENABLED_NETWORKS` now includes `base-mainnet`: ☐
- `PACT_RPC_URL_BASE_MAINNET` set (provider): `____________`
- `PACT_SETTLER_KEYPAIR_BASE_MAINNET` in Secret Manager: ☐
- Prod images rebuilt from `feat/multi-network`: ☐

**Step 4 DB**
- `prisma migrate deploy` run on prod: ☐
- `/api/endpoints` shows base-mainnet endpoints after sync: ☐

**Step 7 verify**
- One real settle through prod settler (tx hash): `0x____________________`
- Forced-breach refund/payout confirmed on-chain (tx hash): `0x____________________`
