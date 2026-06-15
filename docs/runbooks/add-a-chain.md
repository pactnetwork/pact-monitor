# Runbook: Add a new chain to Pact multi-network

Pact is config-driven: one Docker image per service, and `PACT_ENABLED_NETWORKS`
decides which networks an instance serves. Adding a chain = deploy/identify the
on-chain program, register the chain in the client, and wire env. No new image,
no forked code path.

Ownership: **Dev (Tu)** does the code + on-chain steps (forge/cast); **Ops (Rick)**
does the Cloud Run env + secrets. See memory `gcp-ownership`.

Naming rule: an EVM network's name must NOT start with `solana` — `networkToVm`
treats any non-`solana*` network as EVM (secp256k1/EIP-191 auth, EVM adapter).
`NETWORK_UPPER` in env keys = `network.replace(/-/g,"_").toUpperCase()`
(e.g. `base-mainnet` -> `BASE_MAINNET`).

---

## A. Add a new EVM chain (e.g. Base)

### A1. Deploy the 3 contracts (Tu, forge)

From `packages/program-evm/protocol-evm-v1`, run `script/Deploy.s.sol` against the
new chain. It deploys `PactRegistry` -> `PactPool` -> `PactSettler`, auto-grants
the PactSettler **contract** `SETTLER_ROLE` on pool + registry, and asserts the
live USDC has 6 decimals (reverts otherwise).

```
DEPLOYER_PRIVATE_KEY=0x... \
TREASURY_VAULT_ADDRESS=0x... \
CHAIN_ID=<chainId> \
forge script script/Deploy.s.sol --rpc-url <CHAIN_RPC> --broadcast
```

Record the deployed `registry`, `pool`, `settler` addresses + the USDC address.

### A2. Authorize the off-chain settler signer (Tu, cast)

`settleBatch` is `onlyRole(SETTLER_ROLE)` on PactSettler, so the off-chain
cranker EOA (the settler signer) must hold `SETTLER_ROLE` on the **PactSettler**
contract:

```
cast send <PactSettler> "grantRole(bytes32,address)" \
  $(cast keccak "SETTLER_ROLE") <SETTLER_SIGNER_EOA> \
  --rpc-url <CHAIN_RPC> --private-key <AUTHORITY_KEY>
# verify:
cast call <PactSettler> "hasRole(bytes32,address)" $(cast keccak "SETTLER_ROLE") <SETTLER_SIGNER_EOA> --rpc-url <CHAIN_RPC>   # -> true
```

(The PactSettler-contract-to-pool/registry grants were already done by Deploy in A1.)

### A3. Fund the settler signer (Tu)

Send the chain's native gas token to `<SETTLER_SIGNER_EOA>`. The settler's
per-network EVM balance monitor warns/alerts below threshold.

### A4. Register endpoints (Tu, cast — authority only)

`registerEndpoint` is `onlyAuthority`. slug is a `bytes16` of the endpoint name.
`FeeRecipient` is `(uint8 kind, address destination, uint16 bps)`, array length 8.

```
cast send <PactRegistry> \
  "registerEndpoint(bytes16,uint64,uint16,uint32,uint64,uint64,bool,uint8,(uint8,address,uint16)[8])" \
  <slug_bytes16> <flatPremium> <percentBps> <slaLatencyMs> <imputedCost> \
  <exposureCapPerHour> <feeRecipientsPresent> <feeRecipientCount> <feeRecipients> \
  --rpc-url <CHAIN_RPC> --private-key <AUTHORITY_KEY>
```

(There is no CLI/dashboard for EVM endpoint registration yet — `cast` only.)

### A5. Register the chain in the client code (Tu)

1. Add the chain to `packages/program-evm/protocol-evm-v1/config/chains.json`
   (single source of truth, consumed by `@pact-network/shared` `getChain`):

   ```json
   "base-mainnet": {
     "chainId": 8453,
     "name": "base-mainnet",
     "usdcAddress": "0x...",
     "usdcDecimals": 6,
     "rpcUrl": "https://...",
     "blockTimeMs": 2000,
     "finalityBlocks": 64,
     "deploymentBlock": <block the contracts were deployed at>
   }
   ```

2. Add deployment addresses to `packages/protocol-evm-v1-client/src/addresses.ts`
   `DEPLOYMENTS[<chainId>] = { chainId, usdc, registry, pool, settler }`.
   OR supply them via env (see B). Precedence in `resolveDeployment`:
   per-chain env (`PACT_EVM_REGISTRY_<NETWORK_UPPER>`, `..._POOL_...`, `..._SETTLER_...`)
   -> legacy global (`PACT_EVM_REGISTRY` etc.) -> baked `DEPLOYMENTS`.
   For 2+ EVM chains in one fleet you MUST bake into `DEPLOYMENTS` or use the
   per-chain env keys — the global keys cannot disambiguate two chains.

3. `pnpm -r build`, then a read-only smoke (construct the `EvmAdapter` for the
   new network and call `readEndpointConfigs()` against the live RPC) to confirm
   the contracts + chain config resolve.

---

## B. Wire the deploy env (Ops/Rick — per Cloud Run service)

- **All services:** add the network to `PACT_ENABLED_NETWORKS`
  (e.g. `solana-devnet,arc-testnet,base-mainnet`).
- **Settler only:**
  - `PACT_SETTLER_KEYPAIR_<NETWORK_UPPER>` = the settler signer's raw `0x`-hex key
    (Phase 1 accepts only a raw hex VALUE — a Secret Manager `projects/...` path
    string is skipped; inject the secret as the env var's value).
  - optional `PACT_RPC_URL_<NETWORK_UPPER>` (else falls back to chains.json `rpcUrl`).
  - optional `PACT_EVM_GAS_WARN_WEI_<NETWORK_UPPER>` / `PACT_EVM_GAS_CRIT_WEI_<NETWORK_UPPER>`
    (defaults 1e16 / 3e15 wei).
  - If addresses aren't baked into `DEPLOYMENTS`: `PACT_EVM_REGISTRY_<NETWORK_UPPER>`,
    `PACT_EVM_POOL_<NETWORK_UPPER>`, `PACT_EVM_SETTLER_<NETWORK_UPPER>`.
- **Indexer + market-proxy:** add to `PACT_ENABLED_NETWORKS` only (read-only, no signer).
- **DB:** the per-network sync cursor uses the existing `SyncCursor` table — no new
  migration per chain.

---

## C. Verify (post-deploy)

- `GET https://indexer.pactnetwork.io/api/endpoints` lists the new chain's endpoints.
- Settler `/health` returns 200.
- Run one real settle -> confirm indexer rows (Settlement / endpoint FK / PoolState /
  recipient shares) all land under `network=<the new network>`, none under another.

---

## D. Add a new Solana network (simpler — no contract deploy)

- The Pact program must already be deployed on that cluster. Mind the program-id
  drift (memory `solana-program-id-drift`): devnet state is on
  `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`, mainnet on
  `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` (the client default). A
  devnet-targeting service must point the Solana adapter at the devnet program,
  not the mainnet default.
- Add a `solana-<cluster>` entry to `_solanaEntries` in
  `packages/shared/src/chains.ts` (usdcMint, decimals).
- Env: `PACT_ENABLED_NETWORKS += ,solana-<cluster>`,
  `PACT_SETTLER_KEYPAIR_SOLANA_<CLUSTER>` (base58 JSON keypair),
  `PACT_RPC_URL_SOLANA_<CLUSTER>`.

---

## Gotchas

- EVM network name must not start with `solana` (VM routing).
- USDC must be 6 decimals on the new chain (Deploy asserts; the protocol assumes it).
- 2+ EVM chains in one fleet -> per-chain `PACT_EVM_*_<NETWORK>` keys or baked
  `DEPLOYMENTS`; never the global keys.
- EVM endpoint registration is `cast` only (no CLI/dashboard yet).
- `protocol-evm-v1-client` currently publishes under `@pact-network`; a rename to
  `@q3labs` (to match the v1/v2 protocol-client convention) is a pending decision.
- Root `turbo build` is currently red on a separate db/db-v2 Prisma collision
  (memory `db-v2-prisma-collision`) — unrelated to chain onboarding; per-package
  builds are clean.
```
