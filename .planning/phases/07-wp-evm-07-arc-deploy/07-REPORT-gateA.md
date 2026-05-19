# WP-EVM-07 Gate A — Deploy Plan

Branch: feat/arc-protocol-v1  
HEAD: 07a79be  
Author date: 2026-05-19

---

## 1. Scope summary

Deploy the three LOCKED contracts (PactRegistry, PactPool, PactSettler) to Arc
Testnet, verify all three on arcscan, fill the null-placeholder addresses in
`packages/protocol-evm-v1-client/src/addresses.ts`, wire the USDC-decimals
guard into the deploy script, and run the D-A drift check before and after.
No contract change is permitted. No push until Gate B captain approval.

---

## 2. Target chain

| Parameter        | Value                                              |
|------------------|----------------------------------------------------|
| Chain id         | 5042002                                            |
| RPC              | https://rpc.testnet.arc.network                    |
| Explorer         | https://testnet.arcscan.app                        |
| Testnet USDC     | 0x3600000000000000000000000000000000000000         |
| USDC decimals    | 6 (ERC-20 IERC20Metadata.decimals())               |
| Faucet           | https://faucet.circle.com (no account required)    |

---

## 3. Operational blocker — STOP until resolved

On-chain execution is BLOCKED. The deploy script requires:

**Named env vars / secrets the deploy script will consume:**

| Env var                  | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `DEPLOYER_PRIVATE_KEY`   | Hex private key (0x-prefixed) of the Arc Testnet deployer EOA |
| `ARC_TESTNET_RPC_URL`    | Already wired in foundry.toml `[rpc_endpoints]`; must be set  |
| `ARCSCAN_API_KEY`        | API key for `forge verify-contract` against arcscan           |
| `TREASURY_VAULT_ADDRESS` | EOA/multisig to receive treasury fees (PactRegistry ctor arg) |

**Minimum faucet USDC required:**

- Gas on Arc is paid in USDC. Each `forge script --broadcast` call costs gas.
  Three contracts deploy in sequence; realistic gas budget for the full deploy
  run (all three contracts + post-deploy SETTLER_ROLE grants) is approximately
  0.1-0.5 USDC testnet depending on Arc's current gas price.
- Pool seeding: the plan calls for a minimal smoke top-up via `PactPool.topUp`
  after deploy (one call with a small amount, e.g. 1 USDC testnet) to prove the
  pool accepts funds. Budget an additional 1-2 USDC testnet for this smoke call.
- **Recommended minimum: 5 USDC testnet** in the deployer EOA before starting
  (covers gas + smoke top-up + retry headroom). The Circle faucet at
  https://faucet.circle.com dispenses testnet USDC without an account.

The deployer key (`DEPLOYER_PRIVATE_KEY`) and the funded EOA are NOT generated
by this crew. They must be supplied by Rick/Alan. Execution of the deploy
script will STOP-AND-ASK at the deploy boundary if these are absent. No
throwaway key will be generated and no on-chain action will be taken without
the captain's Gate A approval AND the provided key.

The authority address baked into PactRegistry at deploy time is the deployer
EOA (or a designated authority address if Rick/Alan supply a separate one).
`TREASURY_VAULT_ADDRESS` must also be confirmed before deploy — it is passed
to the PactRegistry constructor and is immutable after deploy.

---

## 4. Task breakdown and dependency order

Tasks are listed in strict dependency order. A task may not begin until all
tasks it depends on are complete.

### T0 — Pre-flight checks (no on-chain action)

Preconditions; run locally, no key required.

T0-a. Confirm `DEPLOYER_PRIVATE_KEY`, `ARC_TESTNET_RPC_URL`, `ARCSCAN_API_KEY`,
      and `TREASURY_VAULT_ADDRESS` are all set in `.env` (never committed).

T0-b. Confirm deployer EOA has >= 5 USDC testnet (query Arc Testnet or faucet).

T0-c. Run D-A drift check (pre-deploy baseline):

      cd packages/program-evm/protocol-evm-v1 && forge build
      pnpm --filter @pact-network/protocol-evm-v1-client check:abi

      Must print "[abi-drift] PASS: all committed ABIs in sync with the locked
      forge build" — any FAIL is a hard stop (unauthorized contract drift).

T0-d. Confirm working tree is clean:

      git status

      Only expected untracked: `.claude/pr-reviews/` and
      `.planning/phases/07-wp-evm-07-arc-deploy/`. Any other dirty file is a
      hard stop.

### T1 — Author the deploy script (no on-chain action)

Replace the WP-EVM-01 scaffold stub at
`packages/program-evm/protocol-evm-v1/script/Deploy.s.sol` with the real
`forge script` deploy. This is a script-file replacement only — no contract
source change.

The deploy script MUST:

1. Wire the USDC-decimals guard (same `require()` shape as
   `test/UsdcDecimals.t.sol:requireUsdcDecimals`) as the FIRST action in
   `run()`, before any contract construction. Shape:

       require(
           IERC20Metadata(ArcConfig.ARC_TESTNET_USDC).decimals()
               == ArcConfig.EXPECTED_USDC_DECIMALS,
           "USDC_DECIMALS_MISMATCH"
       );

   A wrong-decimals USDC must fail the deploy loudly before any contract is
   deployed. The guard uses `ArcConfig.EXPECTED_USDC_DECIMALS` (value: 6) and
   `ArcConfig.ARC_TESTNET_USDC` (value: 0x3600000000000000000000000000000000000000)
   — both are already imported constants; no new magic numbers.

2. Deploy in this order (dependency order — PactPool and PactSettler both
   require the registry address at construction):

   a. Deploy `PactRegistry` with args:
      - `authority_`: deployer EOA (or designated authority if Rick/Alan supply
        a separate address)
      - `usdc_`: `ArcConfig.ARC_TESTNET_USDC`
      - `treasuryVault_`: `TREASURY_VAULT_ADDRESS` env var
      - `maxTotalFeeBps_`: `ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS` (3000)
      - `defaultRecipients_`: empty 8-slot array (all zero addresses)
      - `defaultCount_`: 0

   b. Deploy `PactPool` with args:
      - `usdc_`: `ArcConfig.ARC_TESTNET_USDC`
      - `registry_`: address of (a)

   c. Deploy `PactSettler` with args:
      - `usdc_`: `ArcConfig.ARC_TESTNET_USDC`
      - `registry_`: address of (a)
      - `pool_`: address of (b)

3. Grant `SETTLER_ROLE` on both `PactRegistry` and `PactPool` to the deployed
   `PactSettler` address (the deployer EOA holds `DEFAULT_ADMIN_ROLE` on both
   by construction — it is `registry.authority()`):

       registry.grantRole(keccak256("SETTLER_ROLE"), address(settler));
       pool.grantRole(keccak256("SETTLER_ROLE"), address(settler));

4. Emit the three deployed addresses via `console.log` (forge-std) for capture
   in the deploy run log.

5. Commit the completed deploy script (file-scoped conventional commit:
   `feat(deploy): real Deploy.s.sol for Arc Testnet — USDC guard + 3-contract
   sequence`). Do NOT broadcast yet.

### T2 — Dry-run simulation (no on-chain action)

Verify the script compiles and runs correctly against a fork of Arc Testnet
(no broadcast, no gas spent):

    cd packages/program-evm/protocol-evm-v1
    forge script script/Deploy.s.sol:Deploy \
      --rpc-url "$ARC_TESTNET_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      -vvvv

The USDC-decimals guard must pass (ArcConfig.ARC_TESTNET_USDC has 6 decimals
on Arc Testnet). If the guard fires here, it means Arc's actual USDC token does
not match the spec — this is a hard stop and escalate to captain before any
broadcast.

### T3 — Broadcast deploy (REQUIRES Gate A approval + key provided)

Broadcast all three contract deployments in a single script run:

    cd packages/program-evm/protocol-evm-v1
    forge script script/Deploy.s.sol:Deploy \
      --rpc-url "$ARC_TESTNET_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      --broadcast \
      --verify \
      --verifier etherscan \
      --verifier-url https://testnet.arcscan.app/api \
      --etherscan-api-key "$ARCSCAN_API_KEY" \
      -vvvv 2>&1 | tee /tmp/deploy-arc-testnet.log

Capture the three deployed addresses from the log. If `--verify` inline fails
(arcscan API format difference — flagged as a residual unknown in the design
spec §4.8.4), fall back to manual verification per T4 below.

### T4 — arcscan verification (one contract at a time if inline failed)

For each of the three contracts, if inline verification in T3 did not succeed:

    forge verify-contract <DEPLOYED_ADDRESS> \
      src/PactRegistry.sol:PactRegistry \
      --chain-id 5042002 \
      --verifier etherscan \
      --verifier-url https://testnet.arcscan.app/api \
      --etherscan-api-key "$ARCSCAN_API_KEY" \
      --constructor-args <abi-encoded-args>

Repeat for PactPool and PactSettler. Record the arcscan verification URLs
(https://testnet.arcscan.app/address/<ADDR>#code) for the Gate B report.

### T5 — Fill addresses.ts

Post-deploy, populate the null placeholders in
`packages/protocol-evm-v1-client/src/addresses.ts` with the deployed addresses.
Use the existing `DEPLOYMENTS` constant (the typed-registry shape is already
correct — `registry | null`, `pool | null`, `settler | null` for Arc Testnet):

    [ARC_TESTNET_CHAIN_ID]: {
      chainId: ARC_TESTNET_CHAIN_ID,
      usdc: ARC_TESTNET_USDC,
      registry: "0x<DEPLOYED_REGISTRY>",
      pool:     "0x<DEPLOYED_POOL>",
      settler:  "0x<DEPLOYED_SETTLER>",
    },

All three addresses MUST be checksummed (EIP-55). The existing
`checksumOrThrow` helper in the same file validates env-overlay addresses; for
the baked constants use `getAddress()` from viem at author time.

Do NOT add a new mechanism — the `resolveDeployment` env-overlay path already
exists and continues to work for consumers who set `PACT_EVM_REGISTRY` /
`PACT_EVM_POOL` / `PACT_EVM_SETTLER`. Baking into `DEPLOYMENTS` gives
zero-config defaults post-WP-07.

Commit: `feat(addresses): fill Arc Testnet deployed addresses post-WP-07 deploy`

### T6 — D-A drift check post-deploy (second pass)

Re-run the drift check to prove the deployed bytecode's ABI still matches the
committed client ABI. Contracts are locked so this should be identical to T0-c,
but this is the official post-deploy evidence pass:

    pnpm --filter @pact-network/protocol-evm-v1-client check:abi

Must print "[abi-drift] PASS: all committed ABIs in sync with the locked forge
build". Record the full stdout for the Gate B report.

### T7 — Smoke read-call against live contracts

Confirm the three deployed contracts are responsive on Arc Testnet with a
read-only call — no gas, no private key needed, pure RPC:

    # registry.authority() — should return the deployer/authority EOA
    cast call <REGISTRY_ADDR> "authority()(address)" \
      --rpc-url https://rpc.testnet.arc.network

    # pool.usdc() — should return ArcConfig.ARC_TESTNET_USDC
    cast call <POOL_ADDR> "usdc()(address)" \
      --rpc-url https://rpc.testnet.arc.network

    # settler.registry() — should return PactRegistry address
    cast call <SETTLER_ADDR> "registry()(address)" \
      --rpc-url https://rpc.testnet.arc.network

    # settler has SETTLER_ROLE on PactRegistry
    cast call <REGISTRY_ADDR> \
      "hasRole(bytes32,address)(bool)" \
      "$(cast keccak "SETTLER_ROLE")" \
      <SETTLER_ADDR> \
      --rpc-url https://rpc.testnet.arc.network

    # settler has SETTLER_ROLE on PactPool
    cast call <POOL_ADDR> \
      "hasRole(bytes32,address)(bool)" \
      "$(cast keccak "SETTLER_ROLE")" \
      <SETTLER_ADDR> \
      --rpc-url https://rpc.testnet.arc.network

All five calls must return the expected values. Record output for Gate B.

### T8 — Gate B report

Write `.planning/phases/07-wp-evm-07-arc-deploy/07-REPORT-gateB.md` containing:
- Deployed addresses (registry / pool / settler) with arcscan links
- Arcscan verification links (one per contract)
- `addresses.ts` diff (the three null -> address fills)
- D-A drift check PASS evidence: T0-c (pre-deploy) and T6 (post-deploy) stdout
- USDC-decimals guard firing proof: T2 dry-run output showing guard passed
- Smoke read-call results (T7 stdout for all five calls)

Then STOP. Wait for captain `07-CAPTAIN-GATE-B-VERDICT.md` before any push or
PR #204 comment.

---

## 5. Rollback / redeploy story

These contracts have no upgradeability (no proxy, no `selfdestruct`). Rollback
means redeploy fresh:

- Arc Testnet is ephemeral/test — old deployments can simply be abandoned (no
  state migration needed; Arc Testnet has no production users).
- Redeploy runs the same T3 broadcast; new addresses will be different from the
  first run. Update `addresses.ts` with the new addresses and repeat T4-T8.
- If the USDC-decimals guard fires during T2 or T3 (wrong-decimals token at
  `ArcConfig.ARC_TESTNET_USDC`), this is a STOP-AND-ASK to captain — it means
  the chain's USDC at that address does not match the spec, which requires a
  design resolution before any deploy proceeds.
- If arcscan verification fails and the API format is incompatible with the
  `--verifier etherscan` path, the fallback is manual source upload via the
  arcscan web UI (paste flattened source via `forge flatten`).

---

## 6. Exact verification commands summary

Pre-deploy:
    cd packages/program-evm/protocol-evm-v1 && forge build
    pnpm --filter @pact-network/protocol-evm-v1-client check:abi

Dry-run (no broadcast):
    cd packages/program-evm/protocol-evm-v1
    forge script script/Deploy.s.sol:Deploy \
      --rpc-url "$ARC_TESTNET_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      -vvvv

Broadcast + inline verify:
    forge script script/Deploy.s.sol:Deploy \
      --rpc-url "$ARC_TESTNET_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      --broadcast \
      --verify \
      --verifier etherscan \
      --verifier-url https://testnet.arcscan.app/api \
      --etherscan-api-key "$ARCSCAN_API_KEY" \
      -vvvv 2>&1 | tee /tmp/deploy-arc-testnet.log

Post-deploy drift check:
    pnpm --filter @pact-network/protocol-evm-v1-client check:abi

Smoke read-calls (replace addresses after T3):
    cast call <REGISTRY> "authority()(address)" --rpc-url https://rpc.testnet.arc.network
    cast call <POOL>     "usdc()(address)"      --rpc-url https://rpc.testnet.arc.network
    cast call <SETTLER>  "registry()(address)"  --rpc-url https://rpc.testnet.arc.network
    cast call <REGISTRY> "hasRole(bytes32,address)(bool)" "$(cast keccak "SETTLER_ROLE")" <SETTLER> --rpc-url https://rpc.testnet.arc.network
    cast call <POOL>     "hasRole(bytes32,address)(bool)" "$(cast keccak "SETTLER_ROLE")" <SETTLER> --rpc-url https://rpc.testnet.arc.network

---

## 7. Contract-change prohibition reminder

The contracts at `packages/program-evm/protocol-evm-v1/src/` are LOCKED
through WP-05. WP-06 added zero contract behavior. WP-07 is deploy + verify
only. If any step below appears to require a contract edit, this crew STOPS and
escalates to the captain via the report file. The deploy script
(`script/Deploy.s.sol`) is NOT a contract source file — replacing the
WP-EVM-01 stub with the real deploy script is within scope.

---

## 8. Commit plan

| Commit | Scope | Message |
|--------|-------|---------|
| T1 done | script/Deploy.s.sol | `feat(deploy): real Deploy.s.sol for Arc Testnet — USDC guard + 3-contract sequence` |
| T5 done | src/addresses.ts | `feat(addresses): fill Arc Testnet deployed addresses post-WP-07 deploy` |

All commits are file-scoped conventional commits. No push until Gate B approval.

---

## 9. Status

GATE A PLAN COMPLETE. Awaiting `07-CAPTAIN-GATE-A-VERDICT.md`.

Execution is BLOCKED on:
1. Captain Gate A approval (this file).
2. `DEPLOYER_PRIVATE_KEY` + funded deployer EOA (>= 5 USDC testnet) provided
   by Rick/Alan.
3. `ARCSCAN_API_KEY` and `TREASURY_VAULT_ADDRESS` confirmed.

No on-chain action, no push, no PR #204 comment until the above are satisfied.
