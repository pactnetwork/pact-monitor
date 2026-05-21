# T6 — Arc Testnet fleet boot — Rick handoff

- **Date:** 2026-05-21
- **Owner:** Rick (Tu lacks GCP Secret Manager + Cloud Run IAM)
- **Pre-req (Tu, DONE):** SETTLER_ROLE granted on PactSettler to the settler EOA. Tx `0x383ba632ff34366b4a98461bf0301574f70e4ce8ae014a27f77ef425d74d9f65`, Arc Testnet block 43317982, confirmed via `cast call hasRole(...) == true`. Settler EOA = `0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859` (reuses the Arc deployer EOA for Arc Testnet only; mainnet will rotate per D6 §6).
- **Code:** merged in PR #222 (merge commit `dadb01c`) on `feat/multi-network`. Rollback tag `pre-mn-05-rollback`.
- **HOTFIX REQUIRED before deploy:** commit `72e892a` on `feat/multi-network-04-evm-fleet` fixes two Arc-Testnet-RPC blockers in `EvmAdapter` (eth_getLogs 10k-block cap pagination + viem Multicall3 chain-object wiring). Discovered via post-merge live-RPC smoke. MUST be on the deployed image — please cherry-pick `72e892a` onto `feat/multi-network` (or wait for the rollup PR) before running the Cloud Run env updates below. Without it, every settler/indexer/market-proxy revision throws on first Arc adapter call.

## What you need from Tu

The raw 0x-hex private key for the settler EOA. Lives in Tu's local `packages/program-evm/protocol-evm-v1/.env` as `DEPLOYER_PRIVATE_KEY`. Tu will send it to you via the secure channel of your choice (1Password share, Signal, encrypted email — NOT plain Slack/email).

Same key is used as the settler signer on Arc Testnet. Address derives to `0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859`.

## Phase 1 — Cloud Run env updates (now)

Three services need env updates. The exact `gcloud` command shape:

```bash
# Settler — needs PACT_SETTLER_KEYPAIR_ARC_TESTNET in addition to the shared envs
gcloud run services update <settler-service-name> \
  --region <region> \
  --update-env-vars PACT_ENABLED_NETWORKS=solana-devnet\,arc-testnet \
  --update-env-vars PACT_LEGACY_DIRECT_SOLANA=false \
  --update-env-vars PACT_SETTLER_KEYPAIR_ARC_TESTNET=0x<rawhex-from-Tu>

# Indexer — read-only, no signer needed
gcloud run services update <indexer-service-name> \
  --region <region> \
  --update-env-vars PACT_ENABLED_NETWORKS=solana-devnet\,arc-testnet \
  --update-env-vars PACT_LEGACY_DIRECT_SOLANA=false

# Market-proxy — read-only, no signer needed
gcloud run services update <market-proxy-service-name> \
  --region <region> \
  --update-env-vars PACT_ENABLED_NETWORKS=solana-devnet\,arc-testnet \
  --update-env-vars PACT_LEGACY_DIRECT_SOLANA=false
```

Notes:
- The backslash before the comma in `solana-devnet\,arc-testnet` escapes the comma for `--update-env-vars` (which treats unescaped commas as key=value separators).
- For the settler EVM key, paste the raw 0x-hex value verbatim. The settler's `secret-loader` auto-detects: a `projects/...` prefix routes through Secret Manager; anything else is treated as a raw key. Phase 2 (your follow-up) swaps to a Secret Manager path with zero code change.

After each `update`, Cloud Run creates a NEW revision and routes 100% of traffic to it. Old revisions stay available for instant rollback.

## Phase 1 — Verify boot

For each service, after the update:

```bash
gcloud run services logs read <service-name> --limit 50 --region <region>
```

You should see, near the bootstrap log line for each service:

- **Settler:** `[settler] adapters bootstrapped: solana-devnet, arc-testnet | legacyDirectSolana=false`
- **Indexer:** `[indexer] adapters bootstrapped: solana-devnet, arc-testnet | legacyDirectSolana=false`
- **Market-proxy:** equivalent log

If any service crashes on boot, Cloud Run keeps serving from the previous revision automatically (no outage). Common bootstrap failures + fixes:

| Symptom | Cause | Fix |
|---|---|---|
| `evm network arc-testnet missing rpcUrl` | `chains.json` not in image (very unlikely, was T1 of WP-MN-04) | Re-deploy from latest `feat/multi-network` |
| `Failed to parse EVM private key for arc-testnet` | env value has whitespace / wrong prefix | Re-run `update-env-vars` with clean hex |
| `No EVM signer loaded for network "arc-testnet"` at submit | `PACT_SETTLER_KEYPAIR_ARC_TESTNET` not set on settler | Verify env in revision spec; re-run update |
| Settler boots but Arc tx reverts with `MissingRole` | Pre-req `grantRole` missing (it isn't — Tu's done) | Re-run Tu's cast send (idempotent) |

## Phase 2 — Secret Manager migration (your follow-up, NOT blocking Phase 1)

When you're ready to move the raw hex into Secret Manager:

```bash
# 1. Create the secret
gcloud secrets create pact-settler-arc-testnet \
  --replication-policy=automatic

# 2. Add the same raw hex as version 1
echo -n "0x<same-hex-from-Tu>" | gcloud secrets versions add pact-settler-arc-testnet \
  --data-file=-

# 3. Grant the settler service account access to read the secret
gcloud secrets add-iam-policy-binding pact-settler-arc-testnet \
  --member=serviceAccount:<settler-sa>@<project>.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

# 4. Swap the Cloud Run env value from raw hex to the resource path
gcloud run services update <settler-service-name> \
  --region <region> \
  --update-env-vars PACT_SETTLER_KEYPAIR_ARC_TESTNET=projects/<project>/secrets/pact-settler-arc-testnet/versions/latest

# 5. Roll + verify boot logs (same as Phase 1)
```

The settler's `secret-loader` detects the `projects/...` prefix and routes through `SecretManagerServiceClient.accessSecretVersion` automatically. No code redeploy needed.

After verifying Phase 2 works for a week, you can scrub the raw hex from prior Cloud Run revision history if your audit policy requires it (otherwise Cloud Run prunes old revisions automatically).

## Phase 1 — End-to-end smoke (after env updates are stable)

1. Register an Arc endpoint via the Pact CLI:
   ```bash
   pnpm cli endpoint register \
     --network arc-testnet \
     --slug arctest1 \
     --upstream "https://httpbin.org/get" \
     --flat-premium 100000  # 0.1 USDC at 6 decimals
   ```
2. Top up the pool with 1 USDC:
   ```bash
   pnpm cli pool top-up --network arc-testnet --slug arctest1 --amount 1000000
   ```
3. From an agent EOA, approve `PactSettler` (`0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f`) to spend 1 USDC:
   ```bash
   cast send 0x3600000000000000000000000000000000000000 \
     "approve(address,uint256)" \
     0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f 1000000 \
     --rpc-url https://rpc.testnet.arc.network \
     --private-key <agent-key>
   ```
4. Make a wrapped HTTP call via the market-proxy:
   ```bash
   curl -X POST "https://market.pactnetwork.io/v1/arctest1/?pact_wallet=<agent-addr>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
5. Verify in the indexer read API:
   ```bash
   curl "https://indexer.pactnetwork.io/api/calls/<callId>?network=arc-testnet"
   ```
   Should return the call row with `network: "arc-testnet"`.
6. Dashboard: filter by `network=arc-testnet` should show the call.

## Rollback (if anything goes wrong)

**Soft rollback** (env-only): re-run the `gcloud run services update` with `arc-testnet` REMOVED from `PACT_ENABLED_NETWORKS`. The EvmAdapter is no longer constructed; Solana traffic continues. Cleanest first step if the EVM side is misbehaving.

**Harder rollback** (revision): `gcloud run services update-traffic <name> --to-revisions <previous-revision>=100`. Routes 100% back to the pre-T6 revision.

**Hardest rollback** (branch): `git reset --hard pre-mn-05-rollback` on `feat/multi-network` and force-push. Reverts ALL of WP-MN-04 code. Only if a deep bug is found.

**On-chain rollback** (settler EOA): from the deployer EOA, `cast send PactSettler.revokeRole(SETTLER_ROLE, 0x777d56...)`. Effective immediately. Tu can do this directly without your help.

## Status — what's done, what's open

| Item | Owner | Status |
|---|---|---|
| WP-MN-04 code | captain-proxy | ✅ merged into feat/multi-network (PR #222, `dadb01c`) |
| EVM RPC compat hotfix (eth_getLogs chunking + Multicall3) | captain-proxy | ✅ commit `72e892a` on feat/multi-network-04-evm-fleet — MUST land on feat/multi-network before deploy |
| Pre-mn-05-rollback tag | captain-proxy | ✅ pushed |
| `grantRole(SETTLER_ROLE, 0x777d56...)` on Arc Testnet | Tu | ✅ tx `0x383ba632...` |
| Cloud Run env updates × 3 services | **Rick** | **⏸ this doc** |
| Verify boot logs | **Rick** | ⏸ |
| End-to-end smoke on Arc Testnet | **Rick** | ⏸ |
| Phase 2 Secret Manager swap | **Rick** | ⏸ post-Phase-1 follow-up |
| `cleanup/remove-mn-direct-client-flag` WP | TBD | ⏸ 1 week after Phase 1 stable |
