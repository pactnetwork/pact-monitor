# WP-MN-01 — RESEARCH

- **Purpose:** Gate A entry artifact. Enumerates every file the WP-MN-01 refactor touches, locks RESEARCH-time decisions, and breaks the work into sub-task PLAN files.
- **Companion to:** `mn-01-CONTEXT.md`
- **Branch:** `feat/multi-network-01-evm-contract-generalize` (off `feat/multi-network` off `feat/arc-protocol-v1@06e5f26`)
- **Date:** 2026-05-20

---

## 1. Architecture-spec reference quotes

From `docs/evm/2026-05-19-multi-network-architecture-spec.md`:

- **§3 L1 (Contracts per VM):** "Per-VM canonical contract sets… EVM: Arc 3-contract Solidity set (PactRegistry/PactPool/PactSettler + PactEvents/PactErrors), chain values lifted into config (chains.json), `ProtocolInvariants.sol` for protocol-wide constants."
- **§4 (Package layout):** "`packages/program-evm/protocol-evm-v1/` — contracts; `packages/program-evm/protocol-evm-v1/config/chains.json` — per-chain table; `packages/protocol-evm-v1-client/` — TS client mirrors chain table."
- **§11 D1 (LOCKED):** "One chain abstraction org-wide vs per-chain forks — DECIDED: one abstraction (adopt the spec). No new per-chain forks."
- **§11 D2 (LOCKED):** "Who owns the network registry — DECIDED: `@pact-network/shared`/`core` owns it; the SDK consumes it." (D2 places the runtime registry in `@pact-network/shared`; WP-MN-01 only authors the source-of-truth file at `packages/program-evm/protocol-evm-v1/config/chains.json` — the registry helpers in shared come in WP-MN-02.)

From `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §3:

- Five deliverables (ProtocolInvariants.sol, chains.json, Deploy.s.sol refactor, constants.ts mirror, drift test).
- Four sub-tasks, listed in §6 below.
- 7-cat Gate B exit with specific tests: `forge test` count preserved, drift test green, USDC-decimals guard negative-test on synthetic 18-decimal chain entry.

From `docs/evm/2026-05-19-multi-network-READ-FIRST.md`:

- Acceptance: Solana parity minus pay.sh. WP-MN-01 does not touch acceptance (it's pre-work).
- Anchor crate frozen — out of scope.

---

## 2. Audit results — every `ArcConfig` reference in the repo

Method: `grep -rn "ArcConfig" packages/ --include="*.sol" --include="*.ts" --include="*.json" --include="*.toml" --include="*.md"` from repo root on `feat/multi-network-01-evm-contract-generalize` at `06e5f26`.

### 2.1 Solidity source (must rename type + adjust imports)

| File | Line(s) | Reference |
|---|---|---|
| `packages/program-evm/protocol-evm-v1/src/ArcConfig.sol` | 1–32 | The library definition itself. Renamed to `ProtocolInvariants.sol`. |

### 2.2 Solidity test (must update imports + read chain values from new source)

| File | Lines | Reference |
|---|---|---|
| `test/ArcConstants.t.sol` | 5, 9–13 | Imports `ArcConfig`; asserts `MAX_BATCH_SIZE`, `MIN_PREMIUM`, `MAX_FEE_RECIPIENTS`, `ABSOLUTE_FEE_BPS_CAP`, `DEFAULT_MAX_TOTAL_FEE_BPS`. All five are protocol-wide invariants → assertions stay, only import changes to `ProtocolInvariants`. |
| `test/Deployment.t.sol` | 7, 25, 35, 37, 39, 48, 50, 52, 57, 64, 66, 69 | Imports `ArcConfig`; reads `ARC_TESTNET_USDC` and `ARC_TESTNET_CHAIN_ID`. **Chain-specific** — these must read from `chains.json` (see §5.1 decision). Protocol-wide `EXPECTED_USDC_DECIMALS` stays in `ProtocolInvariants`. |
| `test/UsdcDecimals.t.sol` | 7, 20, 27, 34, 35, 43 | Imports `ArcConfig`; uses `EXPECTED_USDC_DECIMALS`. Stays in `ProtocolInvariants`. |
| `test/PactPool.t.sol` | 10, 39 | Imports `ArcConfig`; uses `DEFAULT_MAX_TOTAL_FEE_BPS`. Stays in `ProtocolInvariants`. |
| `test/Fuzz.t.sol` | 11, 109, 156, 195, 215 | Imports `ArcConfig`; uses `MIN_PREMIUM` (×2) and `MAX_BATCH_SIZE` (×2). Stays in `ProtocolInvariants`. |

### 2.3 Deploy script (must read chain-id from env)

| File | Lines | Reference |
|---|---|---|
| `script/Deploy.s.sol` | 8, 52, 59, 87 | Imports `ArcConfig`; uses `ARC_TESTNET_USDC` (line 52), `EXPECTED_USDC_DECIMALS` (59), `DEFAULT_MAX_TOTAL_FEE_BPS` (87). After refactor: `usdc` and `defaultMaxFeeBps` read from `chains.json` keyed by `vm.envUint("CHAIN_ID")`; `EXPECTED_USDC_DECIMALS` stays in `ProtocolInvariants`. |

### 2.4 README

| File | Line | Reference |
|---|---|---|
| `packages/program-evm/protocol-evm-v1/README.md` | 29, 35 | Mentions `src/ArcConfig.sol` and pins constants in `.env.example`. Text update: replace with `ProtocolInvariants.sol` + `config/chains.json`. |

### 2.5 TypeScript client (mirror of constants)

| File | Lines | Reference |
|---|---|---|
| `packages/protocol-evm-v1-client/src/constants.ts` | 5, 11, 22, 38 | Comments cite `ArcConfig.sol`. Constants exported: `ARC_TESTNET_CHAIN_ID` (25), `ARC_TESTNET_USDC` (28–29), `EXPECTED_USDC_DECIMALS` (36), `MAX_BATCH_SIZE` (41), `MIN_PREMIUM` (44), `MAX_FEE_RECIPIENTS` (47), `ABSOLUTE_FEE_BPS_CAP` (50), `DEFAULT_MAX_TOTAL_FEE_BPS` (53). |
| `packages/protocol-evm-v1-client/src/addresses.ts` | 12, 16, 19, 24, 36–38 | Imports `ARC_TESTNET_CHAIN_ID` + `ARC_TESTNET_USDC`; populates `DEPLOYMENTS[5042002]`. Comment cites `ArcConfig.sol`. |
| `packages/protocol-evm-v1-client/__tests__/constants.test.ts` | 3–4, 18, 21–25 | Imports + asserts chain-specific values against the parity oracle. Refactor: rename "parity with ArcConfig.sol" → "parity with chains.json + ProtocolInvariants.sol". |
| `packages/protocol-evm-v1-client/__tests__/addresses.test.ts` | 8, 13, 16–18, 26, 32, 41–42, 47 | Uses `ARC_TESTNET`, `ARC_TESTNET_CHAIN_ID`, `ARC_TESTNET_USDC`. These exports stay (backward compat) but resolve via the registry; tests stay green. |
| `packages/protocol-evm-v1-client/__tests__/helpers.test.ts` | 117 | String literal `"ARC_TESTNET_CHAIN_ID"` (likely an `exports` shape test). Update if rename happens; otherwise unchanged. |

**Total references: 40 lines across 12 files.** No reference lives outside `packages/program-evm/protocol-evm-v1/` and `packages/protocol-evm-v1-client/`. No service code (`settler`, `indexer`, `market-proxy`, `wrap`, `sdk`) references `ArcConfig`.

### 2.6 Sanity — what's NOT touched

- `packages/program-evm/protocol-evm-v1/src/{PactRegistry,PactPool,PactSettler,PactEvents}.sol` — no `ArcConfig` import in contract source (verified by grep above). Contracts are parity-LOCKED per the cover memo.
- `packages/program-evm/protocol-evm-v1/src/{errors,interfaces,libraries}/` — no `ArcConfig` imports.
- All service packages (`settler/`, `indexer/`, `market-proxy/`, `wrap/`, `sdk/`) — none import `ArcConfig` or the EVM constants. They will pick up the multi-chain awareness in WP-MN-03a/b/04.

---

## 3. Audit results — hardcoded chain values in `protocol-evm-v1-client/`

| Location | Value | Disposition |
|---|---|---|
| `src/constants.ts:25` | `ARC_TESTNET_CHAIN_ID = 5042002` | Chain-specific → moves to `chains.json["arc-testnet"].chainId`; constants.ts re-exports via the registry. |
| `src/constants.ts:28–29` | `ARC_TESTNET_USDC = "0x3600..."` | Chain-specific → moves to `chains.json["arc-testnet"].usdcAddress`; constants.ts re-exports via the registry. |
| `src/constants.ts:36` | `EXPECTED_USDC_DECIMALS = 6` | **Protocol-wide invariant** (Solana parity) — stays in `constants.ts` as `EXPECTED_USDC_DECIMALS`. Also `chains.json["arc-testnet"].usdcDecimals = 6` (every chain entry asserts its USDC's decimals). The drift test enforces `chain.usdcDecimals === EXPECTED_USDC_DECIMALS` for every chain entry. |
| `src/constants.ts:41` | `MAX_BATCH_SIZE = 50` | Protocol-wide invariant — stays. |
| `src/constants.ts:44` | `MIN_PREMIUM = 100n` | Protocol-wide invariant — stays. |
| `src/constants.ts:47` | `MAX_FEE_RECIPIENTS = 8` | Protocol-wide invariant — stays. |
| `src/constants.ts:50` | `ABSOLUTE_FEE_BPS_CAP = 10_000` | Protocol-wide invariant — stays. |
| `src/constants.ts:53` | `DEFAULT_MAX_TOTAL_FEE_BPS = 3_000` | Protocol-wide invariant — stays. |
| `src/addresses.ts:42–44` | Arc Testnet deployed contract addresses (`registry`, `pool`, `settler`) | **Per-deployment**, not per-chain. Stays in `addresses.ts` as the DEPLOYMENTS table, keyed by chainId. New chains in WP-MN-04 add entries; addresses are never moved to `chains.json` (deployments are mutable; chain metadata is not). |

---

## 4. Audit results — hardcoded chain values in Solidity test suite

| Location | Value | Disposition |
|---|---|---|
| `test/Deployment.t.sol:64` | Asserts `ArcConfig.ARC_TESTNET_CHAIN_ID == 5042002` | Becomes: `assertEq(chains["arc-testnet"].chainId, 5042002)` (read from chains.json via `vm.parseJsonUint`). |
| `test/Deployment.t.sol:66–67` | Asserts `ArcConfig.ARC_TESTNET_USDC == 0x3600...` | Becomes: `assertEq(chains["arc-testnet"].usdcAddress, 0x3600...)` (read from chains.json via `vm.parseJsonAddress`). |
| `test/Deployment.t.sol:69` | Asserts `ArcConfig.EXPECTED_USDC_DECIMALS == 6` | Stays as `ProtocolInvariants.EXPECTED_USDC_DECIMALS == 6`. |

No other tests bake the chain id or USDC literal — all other references go through `ArcConfig.ARC_TESTNET_USDC` (a getter, not a literal).

---

## 5. RESEARCH-time decisions (must be ratified at Gate A)

### 5.1 `chains.json` schema

```json
{
  "arc-testnet": {
    "chainId": 5042002,
    "name": "arc-testnet",
    "usdcAddress": "0x3600000000000000000000000000000000000000",
    "usdcDecimals": 6,
    "rpcUrl": null,
    "blockTimeMs": null,
    "finalityBlocks": null
  }
}
```

**Rationale:**
- `chainId`, `name`, `usdcAddress`, `usdcDecimals` are populated for Arc Testnet from the live ArcConfig values.
- `rpcUrl`, `blockTimeMs`, `finalityBlocks` are **`null`** for WP-MN-01. They are populated in WP-MN-04 (Arc fleet stand-up) when the policy decision (D6) lands. Schema reserves the keys now so the consumer code in WP-MN-02..04 doesn't need to add them later.
- `treasury` is intentionally **NOT** in chains.json — it's per-deployment, set via env var (`TREASURY_VAULT_ADDRESS`), and the Deploy script's existing `address(0)` check at Deploy.s.sol:55–56 stays as the backstop.

**Validation:** A Vitest schema check in the client suite that asserts every entry has the four required keys with the expected types. Optional keys (`rpcUrl`, `blockTimeMs`, `finalityBlocks`) can be `null` but if present must be the typed value.

### 5.2 `EXPECTED_USDC_DECIMALS` placement

**Decision:** Stays as a protocol-wide invariant in `ProtocolInvariants.sol` AND mirrored in `constants.ts`. Per-chain `usdcDecimals` in `chains.json` is an *assertion* about that chain's USDC, not the protocol's expectation. The drift test enforces `every chain.usdcDecimals === ProtocolInvariants.EXPECTED_USDC_DECIMALS`. If a future EVM chain has a non-6-decimal "USDC," the drift test fires loudly, forcing an explicit decision (different mint, different math, or skip the chain) rather than silently letting the wrong decimals through.

**Rationale:** This preserves the existing Deploy.s.sol guard (line 58–61) verbatim. The guard reads the on-chain USDC's decimals at deploy time and asserts == `ProtocolInvariants.EXPECTED_USDC_DECIMALS`. The chains.json `usdcDecimals` field is documentation + a static cross-check (the drift test); the runtime guard remains the primary control.

### 5.3 chains.json file location

**Decision:** `packages/program-evm/protocol-evm-v1/config/chains.json` (per design spec §3 deliverable).

**Considered and rejected:** `packages/shared/config/chains.json` (so both Solidity and TS read from one path). Rejected because:
- Foundry's `vm.readFile` reads relative to the Foundry project root (`packages/program-evm/protocol-evm-v1/`). Placing the file outside that root means a `../../../shared/config/chains.json` path in every test — fragile.
- TS client can read via a relative import (`../../program-evm/protocol-evm-v1/config/chains.json`) at build time and bake into constants.ts, OR mirror the values and rely on the drift test.

**Decision on TS mirror strategy:** **Mirror, with the drift test as the cross-check.** No build-time chains.json import — constants.ts hand-mirrors values, the drift test asserts equivalence. Simpler build (no JSON loader, no codegen step), unambiguous behavior, and the drift test is the single point of truth that catches divergence.

### 5.4 Drift-test design

`packages/protocol-evm-v1-client/test/chain-table-drift.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as constants from "../src/constants.js";

const chains = JSON.parse(
  readFileSync(
    join(__dirname, "../../program-evm/protocol-evm-v1/config/chains.json"),
    "utf-8",
  ),
);

describe("chain-table drift — chains.json vs constants.ts", () => {
  it("arc-testnet chainId matches", () => {
    expect(chains["arc-testnet"].chainId).toBe(constants.ARC_TESTNET_CHAIN_ID);
  });

  it("arc-testnet USDC address matches (case-insensitive)", () => {
    expect(chains["arc-testnet"].usdcAddress.toLowerCase()).toBe(
      constants.ARC_TESTNET_USDC.toLowerCase(),
    );
  });

  it("every chain's usdcDecimals equals protocol-wide EXPECTED_USDC_DECIMALS", () => {
    for (const [name, c] of Object.entries(chains)) {
      expect((c as { usdcDecimals: number }).usdcDecimals).toBe(
        constants.EXPECTED_USDC_DECIMALS,
      );
    }
  });
});
```

Runtime <50ms. One file, one assertion per drift surface. Passes today (single chain entry); future chain additions in WP-MN-04 extend it for free.

### 5.5 Backward-compat exports in constants.ts

`ARC_TESTNET_CHAIN_ID` and `ARC_TESTNET_USDC` exports **stay** (they're imported by `addresses.ts` and external tests). They are the constants.ts mirror of the chains.json entry. No deprecation warning needed at this WP — when WP-MN-02 introduces the `getChain('arc-testnet')` accessor in `@pact-network/shared`, that becomes the preferred API and constants.ts can downgrade to re-exporting from the registry.

### 5.6 Negative test for the USDC-decimals guard

Per the design spec §3 Gate B exit step 3: "USDC-decimals deploy guard fires on a synthetic 18-decimals chain entry (negative test)."

**Implementation:** A new Foundry test `test/UsdcDecimals.t.sol`'s existing `MockUSDC18` pattern (already used at line 43: `assertTrue(bad.decimals() != ArcConfig.EXPECTED_USDC_DECIMALS)`) is extended with a deploy-script-shape test: instantiate a 18-decimal mock USDC, attempt to run the guard, expect `require(false, "USDC_DECIMALS_MISMATCH")`. This test was already shape-feasible at PR #204; WP-MN-01 just gives it a name and pins it.

---

## 6. Sub-task breakdown (PLAN files)

| PLAN | Title | Files touched | Test added/changed |
|---|---|---|---|
| `mn-01-01-PLAN.md` | Rename + grep audit follow-through | Rename `src/ArcConfig.sol` → `src/ProtocolInvariants.sol`; update all 6 `*.sol` imports listed in §2.1+2.2; update Deploy.s.sol import; rename library type inline | `forge build` succeeds; all existing Foundry tests pass with identical counts |
| `mn-01-02-PLAN.md` | chains.json + schema validation | Create `config/chains.json` with arc-testnet entry per §5.1; add a Vitest schema-shape test in client suite (separate from drift test) | `pnpm --filter @pact-network/protocol-evm-v1-client test` adds a new green test |
| `mn-01-03-PLAN.md` | Deploy.s.sol chain-agnostic refactor (preserve guard) | Refactor `script/Deploy.s.sol` to read `vm.envUint("CHAIN_ID")` + parse chains.json via `vm.parseJson*`; keep `usdc` derived path; keep the existing decimals-guard require() at its current position; update `test/Deployment.t.sol` to read chain values from chains.json the same way | Existing Deployment.t.sol tests pass; new "deploy script reads from chains.json" test asserts the wiring |
| `mn-01-04-PLAN.md` | constants.ts mirror + drift test + negative test | Update `constants.ts` comments to cite chains.json + ProtocolInvariants.sol; create `test/chain-table-drift.test.ts` per §5.4; pin the USDC-decimals 18-dec negative test per §5.6 (named, asserted) | Drift test green; negative test green |

Each PLAN is **2–5 minutes per step** per writing-plans rigor (writing-plans skill conventions apply when WP-MN-01 reaches its plan phase). Total: 4 sub-tasks × ~5 steps each ≈ 20 atomic steps for execution.

---

## 7. Risks (carry forward to PLAN)

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Grep audit missed a transitive `ArcConfig` reference (e.g. via codegen, tooling config, env-example file) | §2 audit is repository-wide across the relevant extensions (`*.sol *.ts *.json *.toml *.md`) — but Gate A captain must re-run a vanilla `grep -rn ArcConfig packages/` as a sanity check. |
| R2 | Foundry's `vm.parseJsonAddress` / `vm.parseJsonUint` behaves unexpectedly on the chosen JSON shape | RESEARCH did not prototype this. PLAN `mn-01-03` first step: write a 10-line test that round-trips arc-testnet through `vm.parseJson*` and asserts the values, BEFORE touching Deploy.s.sol. |
| R3 | Drift test relative path breaks under different runners (CI, IDE, Bun vs Node) | Use `node:path` `join(__dirname, ...)` not string concat; tested in PLAN `mn-01-04`. |
| R4 | `addresses.ts` DEPLOYMENTS shape needs a per-chain `usdcDecimals` field too | Out of scope for WP-MN-01. The drift test cross-checks `chains.json` → `EXPECTED_USDC_DECIMALS`; DEPLOYMENTS today is contract-addresses-only and stays that way. |
| R5 | Renaming the Solidity library breaks ABI/bytecode reproducibility against the on-chain Arc Testnet deployment | The library is `library ArcConfig { ... }` — Solidity libraries with only `internal constant` members are **inlined** by the optimizer; no runtime bytecode is generated for the library itself. The bytecode of the three deployed contracts (PactRegistry/Pool/Settler) does not change because no library is `delegatecall`ed. Verified by reading the library: every member is `internal constant`. ✅ |

---

## 8. Open questions / explicitly deferred

- **None blocking Gate A.** WP-MN-04 owns the `rpcUrl`, `blockTimeMs`, `finalityBlocks` values (D6 policy doc) — WP-MN-01 reserves the schema slots with `null`.
- A future chain with `usdcDecimals !== 6` will trip the §5.4 drift test (`every chain.usdcDecimals === EXPECTED_USDC_DECIMALS`). That's not WP-MN-01's problem to solve; it's the cue to make `EXPECTED_USDC_DECIMALS` per-chain. Documented for the future maintainer.

---

## 9. Gate A request

This RESEARCH + the companion CONTEXT satisfy the Gate A entry criteria listed in `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §3.

**Captain (Tu) — please review and emit `mn-01-CAPTAIN-GATE-A-VERDICT.md` with APPROVED or REJECTED + rationale.** On APPROVED, the next step is to author `mn-01-01-PLAN.md` through `mn-01-04-PLAN.md` via `superpowers:writing-plans`, then execute.
