# Base Network Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every task and superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Base Sepolia (testnet) and Base Mainnet (production) to the Pact multi-network fleet. After this plan, the `base-sepolia` and `base-mainnet` networks are registered in the chain registry, EVM protocol contracts are deployed on both chains, contract addresses are baked into the client, and the services can serve them via `PACT_ENABLED_NETWORKS`.

**Architecture:** The multi-network infra (chain registry, ChainAdapter, per-network env resolution, network-keyed DB) is already complete. This plan is a data-and-deploy exercise: register the chain, deploy the contracts, bake addresses, wire env, verify. The only code change is adding `finalityBlockTag` to `ChainDescriptor` so Base can use `"safe"` finality instead of the hardcoded `"finalized"`.

**Tech Stack:** Foundry (forge), TypeScript / NestJS / Hono (services), `cast` for endpoint registration. No new dependencies.

**Branch:** `feat/base-network` (off `feat/multi-network`).

**Runbook reference:** `docs/runbooks/add-a-chain.md` — follow A1-A5 for EVM chain onboarding.

---

## Task 0: Add `finalityBlockTag` to ChainDescriptor + EvmAdapter

**Goal:** Make `blockTag` configurable per network. Base uses `"safe"` (OP Stack sequencer finality, ~2s); Arc stays at `"finalized"` (unchanged behavior). No regression.

**Files:**
- `packages/shared/src/chain-adapter.ts` — add `finalityBlockTag?: "safe" | "finalized"` to `ChainDescriptor` (default `"finalized"`)
- `packages/shared/src/adapters/evm/index.ts` — accept in `EvmAdapterOptions`, use in `readEndpointConfigsFrom`, `tailSettlementEvents`, and the finality wait-loop instead of hardcoded `"finalized"`
- `packages/shared/src/chains.ts` — pass through from chains.json (no change needed — already spreads all descriptor fields)

- [ ] **Step 1: Failing test for `finalityBlockTag` on EvmAdapter**

  Write a test that constructs an `EvmAdapter` with `finalityBlockTag: "safe"` and asserts the adapter uses the `"safe"` block tag (e.g., by inspecting viem transport calls or by a mock). The test fails initially because `ChainDescriptor` and `EvmAdapterOptions` don't accept `finalityBlockTag` yet.

  File: `packages/shared/src/__tests__/evm-adapter-finality.test.ts`

- [ ] **Step 2: Add `finalityBlockTag` to `ChainDescriptor`**

  ```typescript
  // chain-adapter.ts
  export interface ChainDescriptor {
    // ... existing fields ...
    /** Block tag for finality checks. Default "finalized". Base/OP Stack chains may use "safe". */
    finalityBlockTag?: "safe" | "finalized";
  }
  ```

- [ ] **Step 3: Thread through `EvmAdapterOptions`**

  ```typescript
  // adapters/evm/index.ts
  export interface EvmAdapterOptions {
    // ... existing ...
    /** Block tag for finality. Defaults to "finalized". */
    finalityBlockTag?: "safe" | "finalized";
  }
  ```

  Store as `private readonly finalityBlockTag: "safe" | "finalized"` on the class. Default to `"finalized"` in the constructor.

- [ ] **Step 4: Use in `readEndpointConfigsFrom`**

  Replace `blockTag: "finalized"` at line 232 with `blockTag: this.finalityBlockTag`.

- [ ] **Step 5: Use in `tailSettlementEvents`**

  Replace `blockTag: "finalized"` at line 618.

- [ ] **Step 6: Use in `submitSettleBatch` finality wait-loop**

  The finality wait-loop at line 493-505 uses `getTransactionReceipt` by hash (no block tag) and `getBlockNumber()` (latest block). The finality depth check (`depth >= BigInt(this.finalityBlocks)`) does not use a block tag. No change needed here — the `finalityBlockTag` only affects the event-scanning paths.

  **Verify:** confirm no other hardcoded `"finalized"` remains in the adapter.

- [ ] **Step 7: Run all existing tests — no regression**

  ```bash
  pnpm --filter @pact-network/shared test 2>&1 | tail -20
  ```

  Expected: 41 tests pass (same as pre-task baseline).

- [ ] **Step 8: Commit**

  ```bash
  git add -A packages/shared/
  git commit -m "feat(shared): add finalityBlockTag to ChainDescriptor for Base safe-tag support (WP-BASE T0)"
  ```

---

## Task 1: Register Base in the network registry

**Goal:** Add `base-sepolia` and `base-mainnet` entries to `chains.json`, bake constants + deployment address placeholders in the EVM client, and add RPC endpoints to `foundry.toml`. After this task, `getChain("base-sepolia")` and `getChain("base-mainnet")` resolve correctly.

**Files:**
- `packages/program-evm/protocol-evm-v1/config/chains.json` — add both chain entries
- `packages/program-evm/protocol-evm-v1/foundry.toml` — add RPC endpoints
- `packages/protocol-evm-v1-client/src/constants.ts` — add chain-id + USDC exports
- `packages/protocol-evm-v1-client/src/addresses.ts` — add `DEPLOYMENTS` entries (registry/pool/settler = null for now; overridable via env)

- [ ] **Step 1: Add chain entries to `chains.json`**

  ```json
  {
    "arc-testnet": { ... existing ... },
    "base-sepolia": {
      "chainId": 84532,
      "name": "base-sepolia",
      "usdcAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "usdcDecimals": 6,
      "rpcUrl": "https://sepolia.base.org",
      "blockTimeMs": 2000,
      "finalityBlocks": 1,
      "finalityBlockTag": "safe",
      "deploymentBlock": null
    },
    "base-mainnet": {
      "chainId": 8453,
      "name": "base-mainnet",
      "usdcAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "usdcDecimals": 6,
      "rpcUrl": "https://mainnet.base.org",
      "blockTimeMs": 2000,
      "finalityBlocks": 1,
      "finalityBlockTag": "safe",
      "deploymentBlock": null
    }
  }
  ```

  Note: `deploymentBlock` filled in after contract deployment (Task 2).

  **Verify:** Run the existing schema + drift tests — they must accept the new entries:
  ```bash
  pnpm --filter @pact-network/protocol-evm-v1-client test chains-json-schema chain-table-drift
  ```

- [ ] **Step 2: Add RPC endpoints to `foundry.toml`**

  ```toml
  [rpc_endpoints]
  arc_testnet = "${ARC_TESTNET_RPC_URL}"
  base_sepolia = "${BASE_SEPOLIA_RPC_URL}"
  base_mainnet = "${BASE_MAINNET_RPC_URL}"
  ```

- [ ] **Step 3: Add chain constants to `protocol-evm-v1-client/src/constants.ts`**

  ```typescript
  export const BASE_SEPOLIA_CHAIN_ID = _chainsJson["base-sepolia"].chainId;
  export const BASE_SEPOLIA_USDC: Address = _chainsJson["base-sepolia"].usdcAddress as Address;
  export const BASE_MAINNET_CHAIN_ID = _chainsJson["base-mainnet"].chainId;
  export const BASE_MAINNET_USDC: Address = _chainsJson["base-mainnet"].usdcAddress as Address;
  ```

- [ ] **Step 4: Add DEPLOYMENTS placeholders to `addresses.ts`**

  ```typescript
  import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, BASE_MAINNET_CHAIN_ID, BASE_MAINNET_USDC } from "./constants.js";

  export const DEPLOYMENTS: Record<number, PactDeployment> = {
    [ARC_TESTNET_CHAIN_ID]: { ... existing ... },
    [BASE_SEPOLIA_CHAIN_ID]: {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      usdc: BASE_SEPOLIA_USDC,
      registry: null,   // ← filled after deploy
      pool: null,
      settler: null,
    },
    [BASE_MAINNET_CHAIN_ID]: {
      chainId: BASE_MAINNET_CHAIN_ID,
      usdc: BASE_MAINNET_USDC,
      registry: null,    // ← filled after deploy
      pool: null,
      settler: null,
    },
  };
  ```

  The `resolveDeployment` precedence (per-chain env → global env → baked DEPLOYMENTS) means these `null` addresses are safe: they're overridden by `PACT_EVM_REGISTRY_BASE_SEPOLIA` etc. at deploy time until baked.

- [ ] **Step 5: Update chains.ts type expectation for `finalityBlockTag`**

  The `_evmChains` JSON parse in `chains.ts` already spreads all fields from chains.json via `Object.entries` — `finalityBlockTag` passes through automatically. **Verify** by running:
  ```bash
  pnpm --filter @pact-network/shared test 2>&1 | tail -10
  ```

- [ ] **Step 6: Build + test**

  ```bash
  pnpm --filter @pact-network/protocol-evm-v1-client build
  pnpm --filter @pact-network/protocol-evm-v1-client test 2>&1 | tail -15
  pnpm --filter @pact-network/shared build
  pnpm --filter @pact-network/shared test 2>&1 | tail -10
  ```

  Expected: all green. No regression on Arc (existing 53 + schema + drift tests still pass).

- [ ] **Step 7: Commit**

  ```bash
  git add -A packages/program-evm/protocol-evm-v1/ packages/protocol-evm-v1-client/ packages/shared/
  git commit -m "feat(evm): register base-sepolia + base-mainnet in chain registry (WP-BASE T1)"
  ```

---

## Task 2: Deploy contracts on Base Sepolia (Tu, forge)

**Goal:** Deploy `PactRegistry` → `PactPool` → `PactSettler` on Base Sepolia (chain 84532). Record deployed addresses + deployment block.

**Prerequisites:**
- Base Sepolia RPC accessible (`https://sepolia.base.org`)
- `DEPLOYER_PRIVATE_KEY` with ETH on Base Sepolia (same key as Arc deploy) — get from faucet
- `TREASURY_VAULT_ADDRESS` chosen
- `CHAIN_ID=84532` set

**Follows runbook §A1 (Deploy.s.sol).**

- [ ] **Step 1: Dry-run deploy**

  From `packages/program-evm/protocol-evm-v1/`:

  ```bash
  CHAIN_ID=84532 \
    DEPLOYER_PRIVATE_KEY=0x... \
    TREASURY_VAULT_ADDRESS=0x... \
    BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
    forge script script/Deploy.s.sol --rpc-url base_sepolia
  ```

  Expected: script compiles, simulates, prints addresses. No broadcast yet.

- [ ] **Step 2: Broadcast deploy**

  ```bash
  CHAIN_ID=84532 \
    DEPLOYER_PRIVATE_KEY=0x... \
    TREASURY_VAULT_ADDRESS=0x... \
    BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
    forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
  ```

  Record:
  - `PactRegistry` address
  - `PactPool` address
  - `PactSettler` address
  - Deployment block (from tx receipt)

- [ ] **Step 3: Update chains.json + DEPLOYMENTS with deployed addresses**

  Set `deploymentBlock` in `chains.json` for `base-sepolia`.
  Set `registry`, `pool`, `settler` in `DEPLOYMENTS` in `addresses.ts`.

- [ ] **Step 4: Authorize off-chain settler signer (runbook §A2)**

  ```bash
  cast send <PactSettler> "grantRole(bytes32,address)" \
    $(cast keccak "SETTLER_ROLE") <SETTLER_SIGNER_EOA> \
    --rpc-url https://sepolia.base.org --private-key <AUTHORITY_KEY>
  ```

  **Verify:**
  ```bash
  cast call <PactSettler> "hasRole(bytes32,address)" \
    $(cast keccak "SETTLER_ROLE") <SETTLER_SIGNER_EOA> \
    --rpc-url https://sepolia.base.org
  # -> true
  ```

- [ ] **Step 5: Fund settler signer (runbook §A3)**

  Send ETH to `<SETTLER_SIGNER_EOA>` on Base Sepolia (minimum for gas).

- [ ] **Step 6: Register endpoints (runbook §A4)**

  ```bash
  cast send <PactRegistry> \
    "registerEndpoint(bytes16,uint64,uint16,uint32,uint64,uint64,bool,uint8,(uint8,address,uint16)[8])" \
    <slug_bytes16> <flatPremium> <percentBps> <slaLatencyMs> <imputedCost> \
    <exposureCapPerHour> <feeRecipientsPresent> <feeRecipientCount> <feeRecipients> \
    --rpc-url https://sepolia.base.org --private-key <AUTHORITY_KEY>
  ```

- [ ] **Step 7: Bake addresses + commit**

  ```bash
  git add -A packages/program-evm/protocol-evm-v1/ packages/protocol-evm-v1-client/
  git commit -m "feat(evm): deploy contracts on Base Sepolia + bake addresses (WP-BASE T2)"
  ```

- [ ] **Step 8: Read-only smoke test**

  Construct the `EvmAdapter` for `base-sepolia` and call `readEndpointConfigs()` against the live RPC to confirm registry resolves:

  ```bash
  pnpm --filter @pact-network/shared exec tsx -e "
    import { EvmAdapter } from './dist/adapters/evm/index.js';
    import { getChain } from './dist/chains.js';
    const desc = getChain('base-sepolia');
    const adapter = new EvmAdapter({
      descriptor: desc,
      rpcUrl: 'https://sepolia.base.org',
      finalityBlocks: 1,
      blockTimeMs: 2000,
      deploymentBlock: 0n,
    });
    adapter.readEndpointConfigs().then(c => console.log('endpoints:', c.length));
  "
  ```

---

## Task 3: Deploy contracts on Base Mainnet (Tu, forge)

**Goal:** Same as Task 2 but on Base Mainnet (chain 8453). Real ETH gas costs, production Treasury address.

**Follows runbook §A1-A4 identically but with mainnet values.**

- [ ] **Step 1: Dry-run + broadcast deploy** (same as T2 S1-S2, with `CHAIN_ID=8453`, mainnet RPC)
- [ ] **Step 2: Record addresses + deployment block**
- [ ] **Step 3: Update chains.json + DEPLOYMENTS**
- [ ] **Step 4: Authorize settler signer** (cast grantRole on PactSettler)
- [ ] **Step 5: Fund settler signer with ETH**
- [ ] **Step 6: Register endpoints**
- [ ] **Step 7: Bake addresses + commit**
- [ ] **Step 8: Read-only smoke** (construct EvmAdapter for base-mainnet, read endpoint configs)

---

## Task 4: Wire env + end-to-end verification (Tu + Ops)

**Goal:** Services configured to serve Base networks. End-to-end test: agent approves USDC, calls through proxy, settlement lands on-chain.

**Files (env config — not committed to repo):**
- Cloud Run / Docker env: `PACT_ENABLED_NETWORKS`, `PACT_RPC_URL_BASE_*`, `PACT_SETTLER_KEYPAIR_BASE_*`
- Optional: `PACT_EVM_REGISTRY_BASE_*` etc. (only if addresses not baked)

- [ ] **Step 1: Wire dev/staging env for Base Sepolia**

  ```
  PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet,base-sepolia
  PACT_RPC_URL_BASE_SEPOLIA=https://sepolia.base.org
  PACT_SETTLER_KEYPAIR_BASE_SEPOLIA=0x...
  ```

- [ ] **Step 2: Run settler + indexer + proxy locally**

  ```bash
  pnpm --filter @pact-network/settler dev
  pnpm --filter @pact-network/indexer dev
  pnpm --filter @pact-network/market-proxy dev
  ```

  Verify:
  - `/health` on all services return 200
  - Indexer lists Base Sepolia endpoints at `GET /api/endpoints`

- [ ] **Step 3: Run an agent call through the proxy**

  - Approve USDC on Base Sepolia: `cast send <USDC> "approve(address,uint256)" <PactPool> <amount>`
  - Call an endpoint through the proxy with `x-pact-agent` (0x address), `x-pact-signature` (EIP-191)
  - Verify premium debited, settlement lands in indexer with `network: "base-sepolia"`

- [ ] **Step 4: Wire production env for Base Mainnet** (Ops/Rick)

  Cloud Run env: `PACT_ENABLED_NETWORKS+=,base-mainnet`, per-network RPC + keypair secrets.

- [ ] **Step 5: Production smoke**

  - `GET /api/endpoints` lists Base Mainnet endpoints
  - Settler `/health` 200
  - One real settle → verify indexer rows under `network: "base-mainnet"`

---

## Verification checklist

- [ ] `finalityBlockTag` change — existing Arc tests still green, new Base adapter test passes
- [ ] `chains.json` — all three chains (arc-testnet, base-sepolia, base-mainnet) pass schema + drift tests
- [ ] Foundry `forge build` + `forge test` green (no Solidity regression)
- [ ] `pnpm -r build` green across all affected packages
- [ ] Contracts deployed on Base Sepolia (T2) and Base Mainnet (T3) — addresses baked
- [ ] Settler signer authorized and funded on both chains
- [ ] Endpoints registered on both chains
- [ ] Read smoke: `EvmAdapter.readEndpointConfigs()` returns endpoints for both Base networks
- [ ] Write e2e: agent call → premium debit → settlement → indexer `network: "base-sepolia"` / `"base-mainnet"` — confirmed
- [ ] Existing Arc e2e (`arc-testnet-settle-e2e.spec.ts`) still 8/8 (no regression)
