# WP-EVM-07 Gate B — Arc Testnet Deploy + arcscan Verify — REPORT

Branch: feat/arc-protocol-v1
Date: 2026-05-19
Deploy date: 2026-05-19
Status: DEPLOY + VERIFY COMPLETE — awaiting captain GATE B verdict

---

## 1. Deployed addresses (Arc Testnet, chain id 5042002)

| Contract     | Address (EIP-55)                             | Deploy tx                                                          | Block    | Gas      |
|--------------|----------------------------------------------|--------------------------------------------------------------------|----------|----------|
| PactRegistry | 0x056BAC33546b5b51B8CF6f332379651f715B889C   | 0x8fc3ae13689b09e3822fb5901a113c471a4e5216e34f8cdbd95b75244deb42fb | 42953139 | 1959443  |
| PactPool     | 0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE   | 0x4277f574bd96f157199d3619c9a2432e2c63791d14d46d842ea94af414e01942 | 42953143 | 1002854  |
| PactSettler  | 0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f   | 0xde396a4ad5d15b0ef27abde83f6069b6cf8375315efd3d90e7c3d35c0120e687 | 42953150 | 1387366  |

Post-deploy SETTLER_ROLE grants (CALL txs, both status 0x1):

| Call                                    | tx                                                                 | Block    |
|-----------------------------------------|--------------------------------------------------------------------|----------|
| PactRegistry.grantRole(SETTLER_ROLE, settler) | 0x5f87c205e65068f45a4c50b32fae536f18f990b406d178ef8d69061e93f8dc36 | 42953155 |
| PactPool.grantRole(SETTLER_ROLE, settler)     | 0x02f1a15643151b8accb87f65b6181511c788750a2d562f2ecb4a677d00f09cca | 42953160 |

All 5 receipts: status = 0x1 (success). RPC: https://rpc.testnet.arc.network

### Deploy parameters (C1/C2 ratified, verified on-chain)

- authority_ = deployer EOA = 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859 (C1).
- treasuryVault = 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859 (= deployer EOA,
  C2 item 2 testnet simplification; ratified 07-C2-RATIFICATION.md).
- usdc = 0x3600000000000000000000000000000000000000 (ArcConfig).
- maxTotalFeeBps = 3000 (ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS).
- default fee template EMPTY (defaultCount_ = 0) — C2 item 3 ratified.

---

## 2. arcscan verification — HONEST per-contract outcome (C4)

Explorer: https://testnet.arcscan.app

| Contract     | arcscan URL                                                                  | Outcome  |
|--------------|------------------------------------------------------------------------------|----------|
| PactRegistry | https://testnet.arcscan.app/address/0x056BAC33546b5b51B8CF6f332379651f715B889C#code | VERIFIED |
| PactPool     | https://testnet.arcscan.app/address/0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE#code | VERIFIED |
| PactSettler  | https://testnet.arcscan.app/address/0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f#code | VERIFIED |

All three are VERIFIED. Evidence (arcscan getsourcecode API, re-confirmed
fresh at report time):

    PactRegistry  ContractName='PactRegistry' SourceCodeBytes=13278 CompilerVersion='v0.8.30+commit.73712a01' VERIFIED
    PactPool      ContractName='PactPool'     SourceCodeBytes=5566  CompilerVersion='v0.8.30+commit.73712a01' VERIFIED
    PactSettler   ContractName='PactSettler'  SourceCodeBytes=14352 CompilerVersion='v0.8.30+commit.73712a01' VERIFIED

Per-GUID checkverifystatus also returned `Pass - Verified` (status 1) for all
three. The claim "verified" is made ONLY because arcscan returns non-empty
verified source for each contract (C4 requirement satisfied).

### Verification narrative (attempts logged honestly per C4)

The arcscan verifier flow was the design §4.8.4 / foundry.toml residual
unknown. Findings:

1. Inline `--verify` during the broadcast (T3 first attempt) FAILED:
   "Missing etherscan key for chain 5042002" — forge validates the verifier
   config BEFORE broadcasting when `--verify` is set, and Arc chain 5042002 is
   not in forge's built-in chain registry, so the `etherscan` verifier cannot
   map the API key. Crucial: this aborted the run BEFORE any on-chain action —
   verified by deployer nonce = 0 and zero code at the predicted addresses
   (no gas spent, no orphan deploy).
2. Resolution: decoupled deploy from verify (the Gate-A-anticipated T3->T4
   fallback). Re-broadcast WITHOUT `--verify` — ONCHAIN EXECUTION COMPLETE &
   SUCCESSFUL (the addresses in section 1).
3. `forge verify-contract` with `--verifier etherscan` still failed
   ("ETHERSCAN_API_KEY must be set ...") even with the env var exported —
   same root cause (chain 5042002 not in forge's etherscan chain registry).
4. SUCCESS path: arcscan is a Blockscout-based explorer. `forge
   verify-contract --verifier blockscout --verifier-url
   https://testnet.arcscan.app/api` submitted all three (Response: OK, GUIDs
   returned) and arcscan confirmed all three as verified source.

No foundry.toml change and no contract change were needed — only the verifier
backend selection (`blockscout` not `etherscan`) at the CLI. This is a
documented tooling finding for future Arc deploys, not a code change.

---

## 3. addresses.ts diff (T5, committed 838c573)

`packages/protocol-evm-v1-client/src/addresses.ts` — null placeholders ->
deployed addresses, baked into `DEPLOYMENTS`, EIP-55 checksummed via viem
`getAddress`. `resolveDeployment` env overlay (PACT_EVM_REGISTRY/POOL/SETTLER)
left fully intact (no mechanism change). Net:

    -    registry: null,
    -    pool: null,
    -    settler: null,
    +    registry: "0x056BAC33546b5b51B8CF6f332379651f715B889C",
    +    pool: "0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE",
    +    settler: "0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f",

Plus doc-comment updates (D-B placeholder language -> WP-07-complete language)
and the co-located `__tests__/addresses.test.ts` updated from the obsolete
`toBeNull()` placeholder assertions to assert the deployed addresses (the
WP-07 deploy is precisely what invalidates the placeholder test). Client
suite: 41/41 PASS (addresses.test.ts 4/4).

---

## 4. check:abi PASS evidence (D-A drift guard)

### T0-c (pre-deploy baseline, this Gate B cycle)

    [abi-drift] OK: PactRegistry (49 items) in sync
    [abi-drift] OK: PactPool (27 items) in sync
    [abi-drift] OK: PactSettler (28 items) in sync
    [abi-drift] OK: PactEvents (7 items) in sync
    [abi-drift] OK: PactErrors (30 items) in sync
    [abi-drift] PASS: all committed ABIs in sync with the locked forge build

### T6 (post-deploy)

    [abi-drift] fresh forge build in .../program-evm/protocol-evm-v1 ...
    [abi-drift] OK: PactRegistry (49 items) in sync
    [abi-drift] OK: PactPool (27 items) in sync
    [abi-drift] OK: PactSettler (28 items) in sync
    [abi-drift] OK: PactEvents (7 items) in sync
    [abi-drift] OK: PactErrors (30 items) in sync
    [abi-drift] PASS: all committed ABIs in sync with the locked forge build

Both PASS — the deployed bytecode's ABI is identical to the committed client
ABI. Zero contract drift. Contracts were NOT edited (only script/Deploy.s.sol
authored at T1 + addresses.ts/addresses.test.ts filled at T5).

---

## 5. USDC-decimals guard firing proof (T2 dry-run)

The `require(IERC20Metadata(usdc).decimals() == ArcConfig.EXPECTED_USDC_DECIMALS,
"USDC_DECIMALS_MISMATCH")` is the FIRST action in Deploy.run() before any
construction. T2 dry-run (-vvvv, no --broadcast) PASSED the guard — the script
proceeded past it to construction, proving the guard is satisfied for the live
Arc USDC at 0x3600...0000. Console trace (post-guard, pre-broadcast):

    console::log("=== WP-EVM-07 Arc Testnet deploy ===")
    console::log("chain id        :", 5042002)
    console::log("deployer/auth   :", 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859)
    console::log("usdc            :", 0x3600000000000000000000000000000000000000)
    console::log("treasury vault  :", 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859)
    console::log("maxTotalFeeBps  :", 3000)
    console::log("default fee tmpl : EMPTY (defaultCount_=0) [C2 ratified]")
    ... -> SIMULATION COMPLETE (5 txs: 3 CREATE + 2 grantRole)

The guard's negative-control (it reverts on a wrong-decimals token) is proven
in test/UsdcDecimals.t.sol:test_GuardRevertsOnWrongDecimals (the deploy script
reuses the identical require() shape / "USDC_DECIMALS_MISMATCH" string). On Arc
Testnet the guard correctly PASSED (live USDC is 6-decimal), so the deploy
proceeded — the guard did NOT fire (the correct outcome here; a fire would
have been a HARD STOP per the plan).

---

## 6. T7 read-only smoke (REQUIRED Gate B evidence, C3)

5 cast calls against the live contracts (--rpc-url https://rpc.testnet.arc.network),
SETTLER_ROLE = 0x6666bf5bfee463d10a7fc50448047f8a53b7762d7e28fbc5c643182785f3fd3f:

| # | Call                                      | Result                                       | Expected | OK |
|---|-------------------------------------------|----------------------------------------------|----------|----|
| 1 | registry.authority()                      | 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859   | deployer EOA | YES |
| 2 | pool.usdc()                               | 0x3600000000000000000000000000000000000000   | ArcConfig USDC | YES |
| 3 | settler.registry()                        | 0x056BAC33546b5b51B8CF6f332379651f715B889C   | PactRegistry | YES |
| 4 | registry.hasRole(SETTLER_ROLE, settler)   | true                                         | true | YES |
| 5 | pool.hasRole(SETTLER_ROLE, settler)       | true                                         | true | YES |

All 5 correct. The two-layer SETTLER_ROLE grant (E1xE2) is live on-chain: the
deployed PactSettler holds SETTLER_ROLE on BOTH PactRegistry and PactPool. The
optional write top-up smoke (C3) was NOT performed — read-only smoke is the
required and sufficient Gate B evidence per C3; a write smoke is optional only.

---

## 7. Commits (file-scoped, per §8 plan; NOT pushed)

| SHA      | File scope                                                          | Message |
|----------|---------------------------------------------------------------------|---------|
| 46d2ab9  | packages/program-evm/protocol-evm-v1/script/Deploy.s.sol            | feat(deploy): real Deploy.s.sol for Arc Testnet — USDC guard + 3-contract sequence |
| 838c573  | packages/protocol-evm-v1-client/src/addresses.ts + __tests__/addresses.test.ts | feat(addresses): fill Arc Testnet deployed addresses post-WP-07 deploy |

Branch feat/arc-protocol-v1, HEAD 838c573. NOT pushed. NO PR #204 comment.
Awaiting captain GATE B verdict.

---

## 8. Constraints honored

- NO contract change: only script/Deploy.s.sol (the WP-EVM-01 scaffold itself
  scopes the real deploy script to WP-07) + addresses.ts + its co-located
  test. check:abi PASS both passes proves contracts untouched.
- File-scoped conventional commits (§8). No emojis.
- NOT pushed; NO PR #204 comment until captain GATE B verdict.
- No pact skill installer / pact --help run in the live checkout.
- Tree clean: only expected untracked .claude/pr-reviews/ and
  .planning/phases/07-*. forge broadcast/cache/out are gitignored — no
  secret-bearing or build artifact leaked into the tree.
- Secrets: DEPLOYER_PRIVATE_KEY never echoed; .env is gitignored;
  all logging masked private-key patterns.

## 9. Non-blocking observations (out of WP-07 scope, documented not fixed)

- `pnpm --filter @pact-network/protocol-evm-v1-client typecheck` reports 17
  pre-existing `TS18048: '*.args' is possibly 'undefined'` errors in
  `__tests__/encode.test.ts`. CONFIRMED PRE-EXISTING on the committed baseline
  (verified by stashing addresses.ts and re-running typecheck on the pristine
  tree at HEAD 46d2ab9 — same 17 errors). Unrelated to WP-07 (not a contract,
  not addresses.ts, not the deploy script). The package's `test` script is
  `vitest run` (not tsc) and is 41/41 GREEN. Fixing encode.test.ts would be
  out-of-scope scope-creep and violate file-scoped commits — flagged here for
  a future hygiene cycle, deliberately NOT touched.
- C2 mainnet-hardening item (carried from 07-C2-RATIFICATION.md): treasuryVault
  == deployer EOA is a deliberate testnet simplification. Before any mainnet
  deploy, split treasury into a real Safe/multisig distinct from the deployer
  (fresh deploy, no migration since testnet — treasuryVault has no setter).

## 10. State

DEPLOY + VERIFY COMPLETE.

## 11. DONE-STATE (closeout complete)

Captain GATE B verdict: APPROVED (07-CAPTAIN-GATE-B-VERDICT.md) —
independently verified on-chain + repo, zero defects. The Arc EVM track
(WP-EVM-02..07) is COMPLETE: parity port + Arc Testnet deploy + arcscan
verify.

Closeout executed (crew stalled mid-step-3; captain completed steps 3 + 5):
- Step 1 (tracking): ROADMAP.md + STATE.md marked phase 07 + Arc EVM
  milestone COMPLETE — commit e416e28.
- Step 2 (push): origin/feat/arc-protocol-v1 carries 46d2ab9, 838c573,
  e416e28, 4b9b9e7 (+ this DONE-STATE commit). Verified nothing unpushed.
- Step 3 (PR #204): WP-EVM-07 deploy-completion comment posted by the
  captain (crew was permission-blocked on gh).
- Step 4 (handoff): docs/superpowers/handoffs/2026-05-18-arc-evm-port-
  handoff.md "WP-EVM-07 DEPLOY COMPLETE" section (line 669) — commit
  4b9b9e7.
- Step 5 (this block): DONE-STATE appended.

Deployed + arcscan-verified on Arc Testnet (chain 5042002):
PactRegistry 0x056BAC33546b5b51B8CF6f332379651f715B889C ·
PactPool 0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE ·
PactSettler 0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f.

Carries (non-blocking, recorded): C2 mainnet treasury split before any
mainnet deploy; pre-existing TS18048 x17 encode.test.ts hygiene (WP-06
artifact, vitest 41/41 green). Contracts remain LOCKED — deploy added zero
contract behavior.

ARC EVM TRACK CLOSED. No further crew. STOPPED.
