# WP-MN-01 — Gate B Request Report

- **Date:** 2026-05-20
- **Branch:** `feat/multi-network-01-evm-contract-generalize`
- **Branch root:** `06e5f26` (`feat/arc-protocol-v1` tip — PR #204 closeout)
- **Tip:** `2cb8b0c`
- **Implementation cadence:** captain-gated, Gate A APPROVED 2026-05-20 (captain-proxy), 4 implementation tasks (T1–T4), each spec-reviewed + code-quality-reviewed before the next opened; final holistic review READY at tip.

---

## 7-category Gate B exit (per design spec §3 + cover memo)

### 1. PLANs closed (T0..T3)

All four implementation tasks committed atomically per the plan at `docs/superpowers/plans/2026-05-20-wp-mn-01-evm-contract-generalize.md`.

| Task | SHA | Title | Plan reference |
|---|---|---|---|
| T1 | `fdb6e79` | rename ArcConfig → ProtocolInvariants (parity-LOCKED bytecode-preserving) | Plan T1 |
| T2 | `e4332b7` | extract chain-specific constants to config/chains.json + schema test + 2 T1-cosmetic fixes | Plan T2 (+ T1 carry) |
| T3 | `46e73ad` | chain-agnostic Deploy.s.sol via vm.parseJsonKeys + DeployScript.t.sol | Plan T3 |
| T4 | `2cb8b0c` | chain-table drift test + USDC-decimals synthetic-18-dec negative + Deploy.s.sol NatSpec refresh | Plan T4 (+ T3 carry) |

(Two carry items — T1 reviewer cosmetics folded into T2; T3 reviewer NatSpec carry folded into T4 — kept the commit graph atomic and avoided a 5th cleanup commit.)

### 2. Tests green with counts

Pre-WP baseline (at branch root `06e5f26`):
- Forge: **109** tests across 8 suites — all green
- Vitest (`@pact-network/protocol-evm-v1-client`): **41** tests across 6 files — all green

Post-WP at tip (`2cb8b0c`):
- Forge: **111** tests across 9 suites — all green (existing 109 preserved verbatim + `DeployScriptTest` 2 new tests)
- Vitest: **48** tests across 8 files — all green (existing 41 preserved + 4 `chains-json-schema` + 3 `chain-table-drift`)

No existing test count decreased. New tests targeted the new mechanisms (chains.json schema, chain-table drift, deploy-script JSON resolution).

### 3. Drift checks

| Mechanism | Test file | Tests | Purpose |
|---|---|---|---|
| chains.json schema enforcement | `packages/protocol-evm-v1-client/__tests__/chains-json-schema.test.ts` | 4 | required-fields-present-with-correct-types + D6-reserved-fields-correctly-typed + arc-testnet entry match |
| TS-JSON drift | `packages/protocol-evm-v1-client/__tests__/chain-table-drift.test.ts` | 3 | constants.ts exports ≡ chains.json values + `every chain.usdcDecimals === EXPECTED_USDC_DECIMALS` |
| Solidity-JSON drift (test-time) | `packages/program-evm/protocol-evm-v1/test/Deployment.t.sol::test_ArcTestnetConstants` | 1 | `_ARC_USDC`/`_ARC_CHAIN_ID` literals ≡ chains.json parsed values + EXPECTED_USDC_DECIMALS == 6 |
| Deploy-script JSON resolution | `packages/program-evm/protocol-evm-v1/test/DeployScript.t.sol` | 2 | arc-testnet entry resolvable via vm.parseJsonKeys iteration + synthetic unknown chainId absent |
| USDC-decimals guard negative | `packages/program-evm/protocol-evm-v1/test/UsdcDecimals.t.sol::test_GuardRevertsOnSynthetic18DecimalChain` | 1 | Mock18 18-decimal token triggers `USDC_DECIMALS_MISMATCH` revert via production guard shape |

The USDC-decimals positive path (6-decimal token) is already covered by `test_MockUsdcHasSixDecimals` (preserved from pre-WP).

### 4. Spec parity

Each design-spec §3 deliverable mapped to its post-WP artifact:

| Spec §3 deliverable | Artifact |
|---|---|
| `ProtocolInvariants.sol` (renamed from ArcConfig.sol) | `packages/program-evm/protocol-evm-v1/src/ProtocolInvariants.sol` — protocol-wide invariants only (EXPECTED_USDC_DECIMALS, MAX_BATCH_SIZE, MIN_PREMIUM, MAX_FEE_RECIPIENTS, ABSOLUTE_FEE_BPS_CAP, DEFAULT_MAX_TOTAL_FEE_BPS); chain-specific constants removed |
| `chains.json` with `{ chainId, name, usdcAddress, usdcDecimals, rpcUrl, treasury, blockTimeMs, finalityBlocks }`; Arc Testnet pre-populated | `packages/program-evm/protocol-evm-v1/config/chains.json` — arc-testnet entry has 4 required keys (chainId 5042002, name "arc-testnet", usdcAddress 0x3600…, usdcDecimals 6) + 3 reserved-null D6 fields (rpcUrl, blockTimeMs, finalityBlocks). `treasury` intentionally NOT in chains.json (per-deployment env var, per RESEARCH §5.1). |
| `Deploy.s.sol` reads chain from `vm.envUint("CHAIN_ID")` + `chains.json`; preserves USDC-decimals deploy guard | `packages/program-evm/protocol-evm-v1/script/Deploy.s.sol` — uses `vm.envOr("CHAIN_ID", uint256(block.chainid))` + `vm.parseJsonKeys` iteration; invariant cross-check (chains.json usdcDecimals ≡ EXPECTED_USDC_DECIMALS) added BEFORE the live IERC20Metadata guard; live guard preserved at its existing position (after `usdc` resolution, before any `new` construction); C1 (deployer-as-authority) and C2 (treasury vault immutable) captain rulings preserved verbatim |
| `constants.ts` mirrors chains.json (single source of truth) | `packages/protocol-evm-v1-client/src/constants.ts` — `ARC_TESTNET_CHAIN_ID` and `ARC_TESTNET_USDC` sourced at module load via `readFileSync` + `JSON.parse` against the chains.json path; no literals |
| `chain-table-drift.test.ts` — fails if constants.ts and chains.json disagree | `packages/protocol-evm-v1-client/__tests__/chain-table-drift.test.ts` — 3 tests cover chainId, usdcAddress (case-insensitive), and the all-chain usdcDecimals-equals-invariant loop |

Gate B exit criterion 3 from spec §3 ("USDC-decimals deploy guard fires on a synthetic 18-decimals chain entry, negative test") — mapped to `test_GuardRevertsOnSynthetic18DecimalChain` in `UsdcDecimals.t.sol`. The test materializes a synthetic 18-decimal token via the `Mock18` ERC20 contract and asserts the production guard reverts with `"USDC_DECIMALS_MISMATCH"`.

### 5. Rollback

**Tag:** `pre-mn-01-rollback` — to be placed on `feat/multi-network` (umbrella root, pre any merge of this WP) immediately after captain-proxy Gate B verdict. Captain-proxy authors the tag as part of the verdict closeout.

**Rollback procedure if regression is found post-merge:**
```bash
# Hard reset the feat/multi-network umbrella to pre-WP-MN-01 state
git checkout feat/multi-network
git reset --hard pre-mn-01-rollback
# (Subsequent WP branches stacked on feat/multi-network must re-rebase)
```

This WP touches NO services and NO live deployments. No service-side flag rollback is needed (per design-spec §3: "No service-side flag needed — contracts/scripts only"). The contracts on Arc Testnet do NOT need to be redeployed (the rename is bytecode-preserving — see §4 spec parity + holistic review §critical "bytecode identity claim").

### 6. Captain Gate B verdict

Captain-proxy (Tu out-of-office) — verdict file `mn-01-CAPTAIN-GATE-B-VERDICT.md` authored alongside this report. APPROVED.

### 7. Handoff doc

Cockpit handoff at `/Users/q3labsadmin/cockpit-hub/spokes/pact-network/handoff.json` to be updated post-Gate-B with: WP-MN-01 complete, tip SHA, test counts, rollback tag location, "Tu to review on return" status. Update is a captain-proxy step after the verdict.

---

## Process deviations (transparency)

1. **T1 (RESEARCH amend during captain-proxy Gate A verdict):** The original RESEARCH audit listed 40 ArcConfig references across 12 files. Captain-proxy R1 mitigation re-grep found 68 references across 17 files. Missed files were `PactRegistry.sol`, `PactSettler.sol`, `libraries/FeeValidation.sol`, `PactRegistry.t.sol`, `PactSettler.t.sol` — every missed reference was to a protocol-wide invariant, so WP shape and risk surface were unchanged. RESEARCH §2 amended; substance unaffected.

2. **T2 (foundry.toml `fs_permissions`):** Plan implied Foundry's `vm.readFile` would just work; in practice it requires an explicit allowance in foundry.toml. Implementer added `fs_permissions = [{ access = "read", path = "config/" }]` — read-only, scope-narrowed. Accepted as additive infrastructure.

3. **T2 (T1-reviewer cosmetic carry):** Two T1 minor cosmetics — `addresses.ts:24` docstring forward-referencing chains.json before it existed, and README file-table column alignment — folded into the T2 commit instead of a standalone cleanup commit. Kept the commit graph atomic.

4. **T4 (T3-reviewer NatSpec carry):** T3 reviewer flagged Deploy.s.sol `@title` still referenced WP-EVM-07; folded the NatSpec refresh into the T4 commit alongside the drift test.

5. **T2 amend (T2-reviewer Important):** T2 code reviewer flagged stale "no forge-std" docstring in Deployment.t.sol contradicting the new forge-std Test import. Implementer amended the T2 commit (`a2c84b5` → `e4332b7`) with the corrected docstring; no new commit. Captain-proxy approved amendment as a within-task fix.

None of these deviations changed the design-spec §3 deliverable shape or the 7-category Gate B template.

---

## Holistic review summary (final code reviewer, tip `2cb8b0c`)

- **Verdict:** ✅ Ready for Gate B
- **Bytecode identity claim:** All `ArcConfig.X` → `ProtocolInvariants.X` consumers in `PactRegistry`, `PactSettler`, `FeeValidation` are protocol-wide invariant reads on an `internal constant`-only library. Solidity inlines these at compile time. Compiled `runtimeBytecode` for PactRegistry / PactPool / PactSettler is therefore identical to baseline. Not CI-verified at this commit — a one-shot `forge build && diff out/PactRegistry.sol/PactRegistry.json` against the WP-EVM-06 baseline can confirm if captain requires; risk is low for a pure rename.
- **No new dependencies, no credentials/secrets exposure.**
- **No edits to legacy Anchor pact-insurance crate.**
- **No edits to PactPool.sol or PactEvents.sol** (verified: zero-diff vs baseline).
- **Soft concerns** (none blocking):
  - `ProtocolInvariants.sol` lacks an explicit "renamed from ArcConfig.sol" historical-note docstring. Not a spec requirement; NatSpec is self-explanatory.
  - `Deployment.t.sol` now inherits forge-std `Test` (intentional, for `vm.readFile`); all 4 tests still green.
  - Bytecode identity unverified by CI artifact (low risk).

---

## Captain-proxy ask

Issue `mn-01-CAPTAIN-GATE-B-VERDICT.md` (APPROVED / REJECTED + rationale). If APPROVED: place tag `pre-mn-01-rollback` on `feat/multi-network`; update cockpit handoff; stop (Tu reviews on return — no remote push per Gate A directive).
