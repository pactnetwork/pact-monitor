# WP-MN-01 — Generalize EVM Contracts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip Arc-specific assumptions out of the Solidity codebase and its TypeScript client so any EVM chain configures via `chains.json` instead of forking `ArcConfig.sol`. After this WP, adding a chain is a data edit.

**Architecture:** Rename `ArcConfig.sol` → `ProtocolInvariants.sol` (protocol-wide constants only). Extract chain-specific values (`ARC_TESTNET_CHAIN_ID`, `ARC_TESTNET_USDC`) into `packages/program-evm/protocol-evm-v1/config/chains.json`. Refactor `script/Deploy.s.sol` to read chain selection via `vm.envUint("CHAIN_ID")` + `vm.parseJson*`. Mirror values in `packages/protocol-evm-v1-client/src/constants.ts` and enforce equivalence with a Vitest drift test. Contracts keep their existing bytecode (library has only `internal constant` members — Solidity inlines).

**Tech Stack:** Solidity 0.8.30 / Foundry (forge) / TypeScript / Vitest / pnpm workspaces. No new dependencies.

**Branch:** `feat/multi-network-01-evm-contract-generalize` (off `feat/multi-network` off `feat/arc-protocol-v1@06e5f26`).

**Captain-proxy directives** (mn-01-CAPTAIN-GATE-A-VERDICT.md):
- Atomic commits per task, conventional-commit prefixes.
- NO remote pushes until Gate B closes and Tu reviews.
- If a task surfaces a finding that contradicts RESEARCH, PAUSE and surface — fresh captain-proxy verdict required.

**Source-of-truth references:**
- RESEARCH: `.planning/phases/mn-01-evm-contract-generalize/mn-01-RESEARCH.md` §2 (file-by-file audit), §5 (RESEARCH-time decisions).
- CONTEXT: `.planning/phases/mn-01-evm-contract-generalize/mn-01-CONTEXT.md` (5 non-negotiables).

---

## Task 1: Rename `ArcConfig` → `ProtocolInvariants` (parity-LOCKED bytecode-preserving)

**Goal:** Rename the library and update all 17 import / qualifier sites so `forge build` + `forge test` + `pnpm --filter @pact-network/protocol-evm-v1-client test` all stay green. **No logic change.** This task is a pure rename. Chain-specific constants (`ARC_TESTNET_CHAIN_ID`, `ARC_TESTNET_USDC`) **temporarily remain inside `ProtocolInvariants.sol`** at this task's end — Task 2 extracts them to `chains.json`. This split keeps the rename atomic and reviewable.

**Files:**
- Rename: `packages/program-evm/protocol-evm-v1/src/ArcConfig.sol` → `packages/program-evm/protocol-evm-v1/src/ProtocolInvariants.sol`
- Modify (Solidity source):
  - `packages/program-evm/protocol-evm-v1/src/PactRegistry.sol:7,114`
  - `packages/program-evm/protocol-evm-v1/src/PactSettler.sol:9,74,82,83`
  - `packages/program-evm/protocol-evm-v1/src/libraries/FeeValidation.sol:5,32,44,64,130,132,140,154`
- Modify (Solidity tests):
  - `packages/program-evm/protocol-evm-v1/test/ArcConstants.t.sol:5,9-13` — rename the test contract too: `ArcConstantsTest` → `ProtocolInvariantsTest`; rename the file to `ProtocolInvariants.t.sol`
  - `packages/program-evm/protocol-evm-v1/test/Deployment.t.sol:7,25,35,37,39,48,50,52,57,64,66,69`
  - `packages/program-evm/protocol-evm-v1/test/UsdcDecimals.t.sol:7,20,27,34,35,43`
  - `packages/program-evm/protocol-evm-v1/test/PactPool.t.sol:10,39`
  - `packages/program-evm/protocol-evm-v1/test/PactRegistry.t.sol:7,60`
  - `packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol:13,336`
  - `packages/program-evm/protocol-evm-v1/test/Fuzz.t.sol:11,109,156,195,215`
- Modify (Deploy script): `packages/program-evm/protocol-evm-v1/script/Deploy.s.sol:8,52,59,87`
- Modify (TS client comments only): `packages/protocol-evm-v1-client/src/constants.ts:5,11,22,38` and `packages/protocol-evm-v1-client/src/addresses.ts:12,24` — text updates in JSDoc only; exported names unchanged (still `ARC_TESTNET_CHAIN_ID`, `ARC_TESTNET_USDC`, etc. — they describe the chain entry, not the library).
- Modify: `packages/protocol-evm-v1-client/__tests__/constants.test.ts:18,21,22` — `describe`/`it` titles update from "parity with ArcConfig.sol" → "parity with ProtocolInvariants.sol + chains.json".
- Modify: `packages/program-evm/protocol-evm-v1/README.md:29,35`

- [ ] **Step 1: Baseline — record pre-rename green test state**

Run from repo root:

```bash
cd packages/program-evm/protocol-evm-v1 && forge test --summary 2>&1 | tee /tmp/mn-01-t1-baseline-forge.log | tail -20
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/protocol-evm-v1-client test 2>&1 | tee /tmp/mn-01-t1-baseline-vitest.log | tail -30
```

Expected: both green. Note the test counts (forge: `XX tests in XX test contracts`; vitest: `Tests YY passed`). These counts are the floor for every subsequent task.

- [ ] **Step 2: Rename the library file**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
git mv packages/program-evm/protocol-evm-v1/src/ArcConfig.sol packages/program-evm/protocol-evm-v1/src/ProtocolInvariants.sol
```

Then edit the file. Update the contract-type name AND the comments:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ProtocolInvariants
/// @notice Protocol-wide constants for the Pact EVM rails. Bit-identical to
///         the Solana `pact-network-v1-pinocchio/src/constants.rs` (design
///         spec §3). Chain-specific values (chain id, USDC address) live in
///         `config/chains.json`, NOT here.
/// @dev WP-MN-01: renamed from `ArcConfig.sol`. The Arc Testnet chain-id and
///      USDC address temporarily remain here pending Task 2's extraction.
library ProtocolInvariants {
    /// @notice Arc Testnet EVM chain id. Moves to `config/chains.json` in WP-MN-01 Task 2.
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    /// @notice Arc Testnet USDC token. Moves to `config/chains.json` in WP-MN-01 Task 2.
    address internal constant ARC_TESTNET_USDC =
        0x3600000000000000000000000000000000000000;

    /// @notice USDC decimals Pact's premium math assumes (protocol-wide,
    ///         Solana 6-decimal parity). The deploy-script guard at
    ///         Deploy.s.sol asserts the live USDC.decimals() equals this.
    uint8 internal constant EXPECTED_USDC_DECIMALS = 6;

    // --- Protocol parity invariants (design spec §3) ---
    uint16 internal constant MAX_BATCH_SIZE = 50;
    uint64 internal constant MIN_PREMIUM = 100;
    uint8 internal constant MAX_FEE_RECIPIENTS = 8;
    uint16 internal constant ABSOLUTE_FEE_BPS_CAP = 10_000;
    uint16 internal constant DEFAULT_MAX_TOTAL_FEE_BPS = 3_000;
}
```

- [ ] **Step 3: Update Solidity imports + qualifiers**

Run a scripted edit for the contract-source files (the qualifier change is mechanical):

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
# Edit each file: import path + ArcConfig.X → ProtocolInvariants.X
for f in \
  packages/program-evm/protocol-evm-v1/src/PactRegistry.sol \
  packages/program-evm/protocol-evm-v1/src/PactSettler.sol \
  packages/program-evm/protocol-evm-v1/src/libraries/FeeValidation.sol \
  packages/program-evm/protocol-evm-v1/script/Deploy.s.sol \
  packages/program-evm/protocol-evm-v1/test/Deployment.t.sol \
  packages/program-evm/protocol-evm-v1/test/UsdcDecimals.t.sol \
  packages/program-evm/protocol-evm-v1/test/PactPool.t.sol \
  packages/program-evm/protocol-evm-v1/test/PactRegistry.t.sol \
  packages/program-evm/protocol-evm-v1/test/PactSettler.t.sol \
  packages/program-evm/protocol-evm-v1/test/Fuzz.t.sol \
; do
  sed -i.bak \
    -e 's|{ArcConfig} from "./ArcConfig.sol"|{ProtocolInvariants} from "./ProtocolInvariants.sol"|g' \
    -e 's|{ArcConfig} from "../ArcConfig.sol"|{ProtocolInvariants} from "../ProtocolInvariants.sol"|g' \
    -e 's|{ArcConfig} from "../src/ArcConfig.sol"|{ProtocolInvariants} from "../src/ProtocolInvariants.sol"|g' \
    -e 's|\bArcConfig\.|ProtocolInvariants.|g' \
    "$f"
  rm -f "${f}.bak"
done
```

Then handle `test/ArcConstants.t.sol` specially — rename the file AND the contract:

```bash
git mv packages/program-evm/protocol-evm-v1/test/ArcConstants.t.sol \
       packages/program-evm/protocol-evm-v1/test/ProtocolInvariants.t.sol
sed -i.bak \
  -e 's|{ArcConfig} from "../src/ArcConfig.sol"|{ProtocolInvariants} from "../src/ProtocolInvariants.sol"|g' \
  -e 's|\bArcConfig\.|ProtocolInvariants.|g' \
  -e 's|contract ArcConstantsTest|contract ProtocolInvariantsTest|g' \
  -e 's|test_PortedConstantsMatchSolana|test_ProtocolInvariantsMatchSolana|g' \
  packages/program-evm/protocol-evm-v1/test/ProtocolInvariants.t.sol
rm -f packages/program-evm/protocol-evm-v1/test/ProtocolInvariants.t.sol.bak
```

- [ ] **Step 4: Verify Solidity build + tests green**

```bash
cd packages/program-evm/protocol-evm-v1 && forge build 2>&1 | tail -10
```

Expected: `Compiler run successful`. If there's an `unresolved identifier ArcConfig` anywhere, that file was missed; re-grep:

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network && grep -rn "ArcConfig" packages/program-evm/protocol-evm-v1/
```

Expected output: empty. If non-empty, edit the missing files manually and re-build.

Then run tests:

```bash
cd packages/program-evm/protocol-evm-v1 && forge test --summary 2>&1 | tail -20
```

Expected: same test count as Step 1 baseline, all green.

- [ ] **Step 5: Update TS client comments + test titles (no exported names change)**

The exported constant names (`ARC_TESTNET_CHAIN_ID`, `ARC_TESTNET_USDC`) describe the **chain entry**, not the library — they stay. Only JSDoc comments and `describe`/`it` titles update.

Edit `packages/protocol-evm-v1-client/src/constants.ts`:

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
sed -i.bak \
  -e "s|ArcConfig.sol|ProtocolInvariants.sol|g" \
  packages/protocol-evm-v1-client/src/constants.ts
rm -f packages/protocol-evm-v1-client/src/constants.ts.bak
```

Edit `packages/protocol-evm-v1-client/src/addresses.ts`:

```bash
sed -i.bak \
  -e "s|ArcConfig.sol|ProtocolInvariants.sol|g" \
  -e "s|known from ArcConfig|known from ProtocolInvariants + chains.json|g" \
  -e "s|are from \`ArcConfig.sol\`|are from \`ProtocolInvariants.sol\` + \`chains.json\`|g" \
  packages/protocol-evm-v1-client/src/addresses.ts
rm -f packages/protocol-evm-v1-client/src/addresses.ts.bak
```

Edit `packages/protocol-evm-v1-client/__tests__/constants.test.ts`:

```bash
sed -i.bak \
  -e 's|ArcConfig.sol == constants.rs|ProtocolInvariants.sol == constants.rs|g' \
  -e 's|parity with ArcConfig.sol|parity with ProtocolInvariants.sol|g' \
  -e 's|constants match ArcConfig.sol|constants match ProtocolInvariants.sol|g' \
  packages/protocol-evm-v1-client/__tests__/constants.test.ts
rm -f packages/protocol-evm-v1-client/__tests__/constants.test.ts.bak
```

- [ ] **Step 6: Update README**

Edit `packages/program-evm/protocol-evm-v1/README.md`:

```bash
sed -i.bak \
  -e "s|src/ArcConfig.sol|src/ProtocolInvariants.sol|g" \
  -e "s|ArcConfig.sol          Arc Testnet constants|ProtocolInvariants.sol    Protocol-wide constants|g" \
  packages/program-evm/protocol-evm-v1/README.md
rm -f packages/program-evm/protocol-evm-v1/README.md.bak
```

- [ ] **Step 7: Verify TS client tests green**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/protocol-evm-v1-client test 2>&1 | tail -30
```

Expected: same test count as Step 1 baseline, all green.

- [ ] **Step 8: Final sanity grep — no ArcConfig anywhere**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network && grep -rn "ArcConfig" packages/ 2>/dev/null
```

Expected output: empty. If non-empty, fix and rerun Steps 4 + 7.

- [ ] **Step 9: Commit**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
git add -A packages/program-evm/protocol-evm-v1/ packages/protocol-evm-v1-client/
git status --short
git commit -m "refactor(evm): rename ArcConfig -> ProtocolInvariants (WP-MN-01 T1)

Pure rename, no logic change. Library has only internal constant
members — Solidity inlines, deployed bytecode identical. Chain-
specific constants (ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC)
temporarily remain inside ProtocolInvariants.sol pending T2
extraction to config/chains.json.

Affected files (17): 1 src rename, 3 contract sources, 8 test files
(1 renamed + 7 import-only), 1 deploy script, 2 TS client comment
updates, 1 README, 1 TS test title update.

All Foundry + Vitest counts preserved (baseline at start of T1)."
```

---

## Task 2: Extract chain-specific constants to `chains.json` + schema test

**Goal:** Move `ARC_TESTNET_CHAIN_ID` and `ARC_TESTNET_USDC` out of `ProtocolInvariants.sol` (and the TS `constants.ts` mirror) into a single `config/chains.json` file. Add a Vitest schema-shape test that proves chains.json has the required keys with the right types. Drift test (chains.json ↔ constants.ts equivalence) lands in Task 4.

**Files:**
- Create: `packages/program-evm/protocol-evm-v1/config/chains.json`
- Create: `packages/protocol-evm-v1-client/__tests__/chains-json-schema.test.ts`
- Modify: `packages/program-evm/protocol-evm-v1/src/ProtocolInvariants.sol` (remove `ARC_TESTNET_CHAIN_ID` + `ARC_TESTNET_USDC`; protocol-wide invariants stay)
- Modify: `packages/program-evm/protocol-evm-v1/test/ProtocolInvariants.t.sol` (drop chain-specific assertions; only invariants remain)
- Modify: `packages/program-evm/protocol-evm-v1/test/Deployment.t.sol` (read chain values via the new mechanism — see Step 4)
- Modify (TS client): `packages/protocol-evm-v1-client/src/constants.ts` (re-export `ARC_TESTNET_CHAIN_ID` + `ARC_TESTNET_USDC` from the chain table, NOT from `ProtocolInvariants`)

- [ ] **Step 1: Write the failing schema-shape test (RED)**

Create `packages/protocol-evm-v1-client/__tests__/chains-json-schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress } from "viem";

const chainsPath = join(
  __dirname,
  "../../program-evm/protocol-evm-v1/config/chains.json",
);

describe("chains.json — schema shape", () => {
  const raw = readFileSync(chainsPath, "utf-8");
  const chains = JSON.parse(raw) as Record<string, unknown>;

  it("file exists and is a non-empty object", () => {
    expect(typeof chains).toBe("object");
    expect(chains).not.toBeNull();
    expect(Object.keys(chains).length).toBeGreaterThan(0);
  });

  it("every chain has the four required fields with correct types", () => {
    for (const [name, raw] of Object.entries(chains)) {
      const c = raw as Record<string, unknown>;
      expect(typeof c.chainId, `${name}.chainId`).toBe("number");
      expect(typeof c.name, `${name}.name`).toBe("string");
      expect(c.name, `${name}.name === key`).toBe(name);
      expect(typeof c.usdcAddress, `${name}.usdcAddress`).toBe("string");
      expect(
        isAddress(c.usdcAddress as string),
        `${name}.usdcAddress is EIP-55 address`,
      ).toBe(true);
      expect(typeof c.usdcDecimals, `${name}.usdcDecimals`).toBe("number");
    }
  });

  it("D6 reserved fields are present and either null or correctly typed", () => {
    for (const [name, raw] of Object.entries(chains)) {
      const c = raw as Record<string, unknown>;
      for (const key of ["rpcUrl", "blockTimeMs", "finalityBlocks"] as const) {
        expect(key in c, `${name}.${key} is reserved`).toBe(true);
      }
      expect(
        c.rpcUrl === null || typeof c.rpcUrl === "string",
        `${name}.rpcUrl null or string`,
      ).toBe(true);
      expect(
        c.blockTimeMs === null || typeof c.blockTimeMs === "number",
        `${name}.blockTimeMs null or number`,
      ).toBe(true);
      expect(
        c.finalityBlocks === null || typeof c.finalityBlocks === "number",
        `${name}.finalityBlocks null or number`,
      ).toBe(true);
    }
  });

  it("arc-testnet entry matches the known chain id and USDC", () => {
    const arc = chains["arc-testnet"] as Record<string, unknown>;
    expect(arc.chainId).toBe(5042002);
    expect((arc.usdcAddress as string).toLowerCase()).toBe(
      "0x3600000000000000000000000000000000000000",
    );
    expect(arc.usdcDecimals).toBe(6);
  });
});
```

Run it — expect FAIL (file doesn't exist):

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/protocol-evm-v1-client test chains-json-schema 2>&1 | tail -15
```

Expected output: `ENOENT: no such file or directory` for `chains.json`.

- [ ] **Step 2: Create `chains.json` (GREEN the schema test)**

Create `packages/program-evm/protocol-evm-v1/config/chains.json`:

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

Re-run schema test:

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/protocol-evm-v1-client test chains-json-schema 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 3: Drop chain-specific constants from `ProtocolInvariants.sol`**

Edit `packages/program-evm/protocol-evm-v1/src/ProtocolInvariants.sol`. New body:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ProtocolInvariants
/// @notice Protocol-wide constants for the Pact EVM rails. Bit-identical to
///         the Solana `pact-network-v1-pinocchio/src/constants.rs` (design
///         spec §3). Chain-specific values (chain id, USDC address) live in
///         `config/chains.json`.
library ProtocolInvariants {
    /// @notice USDC decimals Pact's premium math assumes (protocol-wide,
    ///         Solana 6-decimal parity). The deploy-script guard at
    ///         Deploy.s.sol asserts the live USDC.decimals() equals this.
    uint8 internal constant EXPECTED_USDC_DECIMALS = 6;

    // --- Protocol parity invariants (design spec §3) ---
    uint16 internal constant MAX_BATCH_SIZE = 50;
    uint64 internal constant MIN_PREMIUM = 100;
    uint8 internal constant MAX_FEE_RECIPIENTS = 8;
    uint16 internal constant ABSOLUTE_FEE_BPS_CAP = 10_000;
    uint16 internal constant DEFAULT_MAX_TOTAL_FEE_BPS = 3_000;
}
```

- [ ] **Step 4: Update consumers of `ProtocolInvariants.ARC_TESTNET_*` to load via `vm.parseJson*`**

Two Solidity sites still reference the chain-specific constants (after Step 3 they're undefined):
- `script/Deploy.s.sol:52` — `usdc = ProtocolInvariants.ARC_TESTNET_USDC`
- `test/Deployment.t.sol:25,35,37,39,48,50,52,57,64,66` — `ProtocolInvariants.ARC_TESTNET_USDC` and `ProtocolInvariants.ARC_TESTNET_CHAIN_ID`
- `test/ProtocolInvariants.t.sol` — the renamed-from-ArcConstants test references neither (per the original file body); confirm at this step.

For **Task 2** we only patch the test side; the deploy-script refactor is Task 3 (it's a bigger change). Until Task 3 lands, the Deploy script will fail compilation. **Strategy:** Stage Task 2 so Deploy.s.sol stays compilable but no longer relies on the removed constants. Use a local helper.

Edit `script/Deploy.s.sol`. Replace the USDC sourcing logic (around line 52) with a tiny inline JSON read:

```solidity
// Was: address usdc = ProtocolInvariants.ARC_TESTNET_USDC;
// Now: read from config/chains.json by CHAIN_ID env var.
uint256 chainId = vm.envOr("CHAIN_ID", uint256(block.chainid));
string memory chainsJson = vm.readFile("config/chains.json");
// Look up the chain entry by chainId. JSON parsing in Foundry uses a
// key path; we iterate the known names. For WP-MN-01 only "arc-testnet"
// is registered; Task 3 generalizes the lookup.
string memory chainName;
if (chainId == 5042002) {
    chainName = "arc-testnet";
} else {
    revert(string.concat("unknown CHAIN_ID: ", vm.toString(chainId)));
}
address usdc = vm.parseJsonAddress(
    chainsJson,
    string.concat(".", chainName, ".usdcAddress")
);
```

This is intentionally narrow at Task 2 — Task 3 generalizes the lookup. The point of Task 2 is to make `ProtocolInvariants.sol` chain-free.

Edit `test/Deployment.t.sol`. Replace every `ProtocolInvariants.ARC_TESTNET_USDC` with a hardcoded literal that mirrors the chains.json value, AND add a single read-from-json test at the bottom:

```solidity
import {Test} from "forge-std/Test.sol";
// ... existing imports ...

contract DeploymentTest is Test {
    // Mirror of chains.json arc-testnet entry. Drift caught by
    // ../test/Deployment.t.sol::test_ArcTestnetChainEntryMatchesChainsJson below.
    address constant _ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 constant _ARC_CHAIN_ID = 5042002;

    function test_DeployPactRegistry() external {
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), _ARC_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        require(address(r).code.length > 0, "registry: no bytecode");
        require(r.authority() == address(this), "registry: authority not set");
    }

    // ... apply same substitution (_ARC_USDC for ProtocolInvariants.ARC_TESTNET_USDC) to test_DeployPactPool, test_DeployPactSettler ...

    function test_ArcTestnetConstants() external {
        // Read directly from chains.json; this test IS the cross-check that
        // the literals in this file mirror the JSON.
        string memory j = vm.readFile("config/chains.json");
        uint256 chainId = vm.parseJsonUint(j, ".arc-testnet.chainId");
        address usdc = vm.parseJsonAddress(j, ".arc-testnet.usdcAddress");
        require(chainId == _ARC_CHAIN_ID, "arc: chain id drift");
        require(usdc == _ARC_USDC, "arc: usdc drift");
        require(ProtocolInvariants.EXPECTED_USDC_DECIMALS == 6, "arc: usdc decimals");
    }
}
```

(Apply the `_ARC_USDC` substitution to every existing usage in the file.)

- [ ] **Step 5: Update TS client constants.ts — re-export from chains.json**

Edit `packages/protocol-evm-v1-client/src/constants.ts`. Replace the inline `ARC_TESTNET_CHAIN_ID` + `ARC_TESTNET_USDC` exports with values sourced from the JSON, then re-exported under the same names (backward compat per RESEARCH §5.5).

```typescript
// At the top of the file, after the existing imports:
import chainsJson from "../../program-evm/protocol-evm-v1/config/chains.json" with { type: "json" };

// Replace lines 22-29 (the // --- Arc Testnet network constants --- block) with:
// --- Arc Testnet network constants (source: config/chains.json) ---

/** Arc Testnet EVM chain id (from chains.json["arc-testnet"].chainId). */
export const ARC_TESTNET_CHAIN_ID = chainsJson["arc-testnet"].chainId;

/** Arc Testnet USDC token (from chains.json["arc-testnet"].usdcAddress). */
export const ARC_TESTNET_USDC: Address = chainsJson["arc-testnet"]
  .usdcAddress as Address;
```

If the workspace's TypeScript / Vitest config rejects the `import ... with { type: "json" }` syntax (try it first, see Step 6), fall back to runtime `JSON.parse(readFileSync(...))` inside an IIFE so the exports stay top-level constants:

```typescript
// Fallback if import-assertion doesn't compile:
import { readFileSync } from "node:fs";
import { join } from "node:path";

const _chainsJson = JSON.parse(
  readFileSync(
    join(__dirname, "../../program-evm/protocol-evm-v1/config/chains.json"),
    "utf-8",
  ),
) as Record<string, { chainId: number; usdcAddress: string; usdcDecimals: number }>;

export const ARC_TESTNET_CHAIN_ID = _chainsJson["arc-testnet"].chainId;
export const ARC_TESTNET_USDC: Address = _chainsJson["arc-testnet"]
  .usdcAddress as Address;
```

Pick whichever the workspace tsconfig accepts at Step 6.

- [ ] **Step 6: Verify everything green**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
cd packages/program-evm/protocol-evm-v1 && forge test --summary 2>&1 | tail -20
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/protocol-evm-v1-client test 2>&1 | tail -30
```

Expected: all green, test counts equal to T1 baseline + 4 new schema tests (chains-json-schema).

If the TS import-assertion fails: switch constants.ts to the readFileSync fallback shown in Step 5, re-run.

- [ ] **Step 7: Sanity — `ProtocolInvariants.sol` is chain-free**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
grep -E "ARC_TESTNET|5042002|0x3600" packages/program-evm/protocol-evm-v1/src/ProtocolInvariants.sol
```

Expected: empty.

- [ ] **Step 8: Commit**

```bash
git add -A packages/program-evm/protocol-evm-v1/ packages/protocol-evm-v1-client/
git commit -m "refactor(evm): extract chain-specific constants to config/chains.json (WP-MN-01 T2)

Moves ARC_TESTNET_CHAIN_ID + ARC_TESTNET_USDC out of
ProtocolInvariants.sol into config/chains.json. Adds a Vitest
schema-shape test guarding the chains.json structure (4 required
fields + 3 reserved-null D6 slots).

ProtocolInvariants.sol is now chain-free; only protocol-wide
invariants remain (MAX_BATCH_SIZE, MIN_PREMIUM, etc.).

Deploy.s.sol + Deployment.t.sol read chain values via vm.parseJson*;
the lookup is hardcoded to arc-testnet here and generalized in T3.
TS client re-exports ARC_TESTNET_* from chains.json for backward
compat.

Test counts: all prior Foundry + Vitest tests still green, +4 new
schema tests in protocol-evm-v1-client."
```

---

## Task 3: Generalize `Deploy.s.sol` for chain-agnostic deploy

**Goal:** Replace the hardcoded `if (chainId == 5042002)` lookup in Deploy.s.sol with a generic mechanism that reads chains.json by `vm.envUint("CHAIN_ID")` (defaulting to `block.chainid`). The USDC-decimals guard stays at its current position and fires before any contract construction.

**Files:**
- Modify: `packages/program-evm/protocol-evm-v1/script/Deploy.s.sol`
- Modify: `packages/program-evm/protocol-evm-v1/test/Deployment.t.sol` (add a "deploy script reads chains.json" sanity test if not already covered by Task 2)

- [ ] **Step 1: Decide the lookup strategy**

Foundry's `vm.parseJson*` supports JSONPath-style key access. To look up a chain by `chainId` (rather than name), we'd need to iterate keys. Foundry has `vm.parseJsonKeys(json, ".")` to enumerate top-level keys. The lookup pattern:

```solidity
string memory chainsJson = vm.readFile("config/chains.json");
string[] memory names = vm.parseJsonKeys(chainsJson, ".");
string memory chainName;
for (uint256 i = 0; i < names.length; i++) {
    uint256 cid = vm.parseJsonUint(
        chainsJson,
        string.concat(".", names[i], ".chainId")
    );
    if (cid == chainId) { chainName = names[i]; break; }
}
require(bytes(chainName).length > 0, "CHAIN_ID not in config/chains.json");
```

This is the pattern used in Step 2.

- [ ] **Step 2: Refactor `Deploy.s.sol`**

Open `packages/program-evm/protocol-evm-v1/script/Deploy.s.sol`. Replace the Task-2 narrow `if (chainId == 5042002)` block with the generic loop. The full updated `run()` body (after the existing parameter-resolution prelude):

```solidity
function run() external {
    uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
    address deployer = vm.addr(deployerKey);

    address treasuryVault = vm.envAddress("TREASURY_VAULT_ADDRESS");
    require(treasuryVault != address(0), "TREASURY_VAULT_ZERO");

    // --- Resolve chain entry from config/chains.json ---
    uint256 chainId = vm.envOr("CHAIN_ID", uint256(block.chainid));
    string memory chainsJson = vm.readFile("config/chains.json");
    string[] memory names = vm.parseJsonKeys(chainsJson, ".");
    string memory chainName;
    for (uint256 i = 0; i < names.length; i++) {
        uint256 cid = vm.parseJsonUint(
            chainsJson,
            string.concat(".", names[i], ".chainId")
        );
        if (cid == chainId) {
            chainName = names[i];
            break;
        }
    }
    require(
        bytes(chainName).length > 0,
        string.concat("CHAIN_ID ", vm.toString(chainId), " not in chains.json")
    );

    address usdc = vm.parseJsonAddress(
        chainsJson,
        string.concat(".", chainName, ".usdcAddress")
    );
    uint256 expectedDecimals = vm.parseJsonUint(
        chainsJson,
        string.concat(".", chainName, ".usdcDecimals")
    );

    // Cross-check: chains.json claims about USDC decimals must match the
    // protocol-wide invariant (else the deploy is wrong-chain-data).
    require(
        expectedDecimals == ProtocolInvariants.EXPECTED_USDC_DECIMALS,
        "CHAIN_USDC_DECIMALS_MISMATCH_INVARIANT"
    );

    // --- Live USDC-decimals guard (preserved from pre-WP-MN-01) ---
    require(
        IERC20Metadata(usdc).decimals() == ProtocolInvariants.EXPECTED_USDC_DECIMALS,
        "USDC_DECIMALS_MISMATCH"
    );

    console.log("=== Pact EVM deploy ===");
    console.log("chain id        :", chainId);
    console.log("chain name      :", chainName);
    console.log("deployer/auth   :", deployer);
    console.log("usdc            :", usdc);
    console.log("treasury vault  :", treasuryVault);
    console.log("maxTotalFeeBps  :", uint256(ProtocolInvariants.DEFAULT_MAX_TOTAL_FEE_BPS));
    console.log("default fee tmpl : EMPTY (defaultCount_=0) [C2 ratified]");

    IPactRegistry.FeeRecipient[8] memory emptyDefaults;
    uint8 defaultCount = 0;

    vm.startBroadcast(deployerKey);

    PactRegistry registry = new PactRegistry(
        deployer, usdc, treasuryVault,
        ProtocolInvariants.DEFAULT_MAX_TOTAL_FEE_BPS,
        emptyDefaults, defaultCount
    );
    PactPool pool = new PactPool(usdc, address(registry));
    PactSettler settler =
        new PactSettler(usdc, address(registry), address(pool));

    bytes32 settlerRole = keccak256("SETTLER_ROLE");
    registry.grantRole(settlerRole, address(settler));
    pool.grantRole(settlerRole, address(settler));

    vm.stopBroadcast();

    console.log("--- DEPLOYED ---");
    console.log("PactRegistry    :", address(registry));
    console.log("PactPool        :", address(pool));
    console.log("PactSettler     :", address(settler));
    console.log("SETTLER_ROLE granted to settler on registry + pool: true");
}
```

- [ ] **Step 3: Add a deploy-script unit test**

Create `packages/program-evm/protocol-evm-v1/test/DeployScript.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";

/// @title DeployScript chains.json resolution test
/// @notice Direct unit test of the chain-lookup pattern used in
///         script/Deploy.s.sol. Proves the chains.json read + cross-check
///         logic works without actually broadcasting.
contract DeployScriptTest is Test {
    function test_ResolvesArcTestnetFromChainsJson() public {
        string memory j = vm.readFile("config/chains.json");
        string[] memory names = vm.parseJsonKeys(j, ".");

        // arc-testnet must be present.
        bool found = false;
        for (uint256 i = 0; i < names.length; i++) {
            if (keccak256(bytes(names[i])) == keccak256(bytes("arc-testnet"))) {
                found = true;
                break;
            }
        }
        require(found, "arc-testnet missing from chains.json");

        uint256 cid = vm.parseJsonUint(j, ".arc-testnet.chainId");
        address usdc = vm.parseJsonAddress(j, ".arc-testnet.usdcAddress");
        uint256 dec = vm.parseJsonUint(j, ".arc-testnet.usdcDecimals");

        assertEq(cid, 5042002, "chainId");
        assertEq(usdc, 0x3600000000000000000000000000000000000000, "usdc");
        assertEq(dec, ProtocolInvariants.EXPECTED_USDC_DECIMALS, "decimals invariant");
    }

    function test_UnknownChainIdHasNoEntry() public {
        string memory j = vm.readFile("config/chains.json");
        string[] memory names = vm.parseJsonKeys(j, ".");
        for (uint256 i = 0; i < names.length; i++) {
            uint256 cid = vm.parseJsonUint(
                j,
                string.concat(".", names[i], ".chainId")
            );
            assertTrue(cid != 9999999, "9999999 must not be in chains.json");
        }
    }
}
```

- [ ] **Step 4: Verify Foundry suite green**

```bash
cd packages/program-evm/protocol-evm-v1 && forge test --summary 2>&1 | tail -20
```

Expected: T1 baseline count + DeployScriptTest's 2 new tests, all green.

- [ ] **Step 5: Smoke-compile the deploy script**

`forge script` requires a private key + env vars; we can't actually broadcast in a test. But `forge build` over the script directory proves it compiles:

```bash
cd packages/program-evm/protocol-evm-v1 && forge build 2>&1 | tail -10
```

Expected: `Compiler run successful`.

- [ ] **Step 6: Commit**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
git add -A packages/program-evm/protocol-evm-v1/
git commit -m "refactor(evm): chain-agnostic Deploy.s.sol via chains.json (WP-MN-01 T3)

Replaces hardcoded arc-testnet lookup with vm.parseJsonKeys-based
iteration. CHAIN_ID env (defaulting to block.chainid) selects the
entry. USDC-decimals guard preserved at its existing position;
additional invariant cross-check added (chains.json usdcDecimals
must equal ProtocolInvariants.EXPECTED_USDC_DECIMALS).

Adds test/DeployScript.t.sol with 2 unit tests proving the
chains.json read + lookup logic. forge build green; live broadcast
gated on env (DEPLOYER_PRIVATE_KEY, TREASURY_VAULT_ADDRESS, CHAIN_ID)."
```

---

## Task 4: Drift test + USDC-decimals negative test (Gate B headline artifacts)

**Goal:** Ship the two tests the design spec §3 Gate B exit names explicitly: the chain-table drift test (chains.json ↔ constants.ts equivalence) and the negative test for the USDC-decimals guard (synthetic 18-decimal chain entry fires the guard).

**Files:**
- Create: `packages/protocol-evm-v1-client/__tests__/chain-table-drift.test.ts`
- Modify: `packages/program-evm/protocol-evm-v1/test/UsdcDecimals.t.sol` (rename existing `test_GuardRevertsOnWrongDecimals` to `test_GuardRevertsOnSynthetic18DecimalChain` per spec §3 Gate B step 3, and re-attest the synthetic-chain-entry framing in a comment)

- [ ] **Step 1: Write the drift test (RED — fails until imports are right)**

Create `packages/protocol-evm-v1-client/__tests__/chain-table-drift.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC,
  EXPECTED_USDC_DECIMALS,
} from "../src/constants.js";

const chainsPath = join(
  __dirname,
  "../../program-evm/protocol-evm-v1/config/chains.json",
);
const chains = JSON.parse(readFileSync(chainsPath, "utf-8")) as Record<
  string,
  { chainId: number; usdcAddress: string; usdcDecimals: number }
>;

describe("chain-table drift — chains.json vs constants.ts", () => {
  it("arc-testnet chainId matches constants.ts export", () => {
    expect(chains["arc-testnet"].chainId).toBe(ARC_TESTNET_CHAIN_ID);
  });

  it("arc-testnet USDC address matches constants.ts export (case-insensitive)", () => {
    expect(chains["arc-testnet"].usdcAddress.toLowerCase()).toBe(
      ARC_TESTNET_USDC.toLowerCase(),
    );
  });

  it("every chain's usdcDecimals equals protocol-wide EXPECTED_USDC_DECIMALS", () => {
    for (const [name, c] of Object.entries(chains)) {
      expect(c.usdcDecimals, `${name}.usdcDecimals`).toBe(
        EXPECTED_USDC_DECIMALS,
      );
    }
  });
});
```

Run:

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/protocol-evm-v1-client test chain-table-drift 2>&1 | tail -15
```

Expected: 3 tests pass (the constants.ts re-export from Task 2 already sources from chains.json, so values match).

- [ ] **Step 2: Rename + annotate the negative test in `UsdcDecimals.t.sol`**

Edit `packages/program-evm/protocol-evm-v1/test/UsdcDecimals.t.sol`. The existing `test_GuardRevertsOnWrongDecimals` already does what spec §3 Gate B step 3 names. Rename it for explicit traceability and add a header comment tying it to the spec criterion:

```solidity
/// @notice WP-MN-01 Gate B exit step 3: "USDC-decimals deploy guard fires
///         on a synthetic 18-decimals chain entry (negative test)." This
///         test materializes a synthetic 18-decimal token (the Mock18 above)
///         and proves the guard reverts loudly with the production error
///         shape ("USDC_DECIMALS_MISMATCH").
function test_GuardRevertsOnSynthetic18DecimalChain() public {
    Mock18 bad = new Mock18();
    // Non-vacuous: the guard distinguishes a wrong-decimals token.
    assertTrue(bad.decimals() != ProtocolInvariants.EXPECTED_USDC_DECIMALS);
    vm.expectRevert(bytes("USDC_DECIMALS_MISMATCH"));
    this.requireUsdcDecimals(address(bad));
}
```

(Delete the old `test_GuardRevertsOnWrongDecimals` — replaced by the renamed test.)

- [ ] **Step 3: Verify everything green**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
cd packages/program-evm/protocol-evm-v1 && forge test --summary 2>&1 | tail -20
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/protocol-evm-v1-client test 2>&1 | tail -30
```

Expected:
- Foundry: T1 baseline + Task 3's 2 DeployScriptTest tests + Task 4's 0 net new (test was renamed, not added). Count == baseline + 2.
- Vitest: T1 baseline + Task 2's 4 schema tests + Task 4's 3 drift tests. Count == baseline + 7.

Existing Foundry test count must NOT decrease (Gate B exit criterion 2).

- [ ] **Step 4: Final captain-proxy spec-parity self-check**

Open the design spec section that defines WP-MN-01 deliverables (`docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §3 "Deliverables") and confirm each bullet has a corresponding artifact on the branch:

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
test -f packages/program-evm/protocol-evm-v1/src/ProtocolInvariants.sol && echo "✓ ProtocolInvariants.sol"
test -f packages/program-evm/protocol-evm-v1/config/chains.json && echo "✓ chains.json"
grep -q "vm.parseJsonKeys" packages/program-evm/protocol-evm-v1/script/Deploy.s.sol && echo "✓ Deploy.s.sol generalized"
grep -q "chainsJson" packages/protocol-evm-v1-client/src/constants.ts && echo "✓ constants.ts mirrors chains.json"
test -f packages/protocol-evm-v1-client/__tests__/chain-table-drift.test.ts && echo "✓ chain-table-drift.test.ts"
grep -q "test_GuardRevertsOnSynthetic18DecimalChain" packages/program-evm/protocol-evm-v1/test/UsdcDecimals.t.sol && echo "✓ synthetic 18-dec negative test"
! grep -rn "ArcConfig" packages/ && echo "✓ no ArcConfig references remain"
```

All seven lines must echo with `✓`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/program-evm/protocol-evm-v1/ packages/protocol-evm-v1-client/
git commit -m "test(evm): chain-table drift + USDC-decimals synthetic-18-dec negative (WP-MN-01 T4)

Adds chain-table-drift.test.ts (3 Vitest tests) cross-checking
chains.json against constants.ts exports. Renames existing
test_GuardRevertsOnWrongDecimals -> test_GuardRevertsOnSynthetic18-
DecimalChain in UsdcDecimals.t.sol to map 1:1 onto the design spec
§3 Gate B exit step 3.

Final spec-parity check: all 5 deliverables on disk, no ArcConfig
references remain. WP-MN-01 implementation tasks complete; Gate B
request artifact authored separately."
```

---

## After all tasks

Gate B request: create `.planning/phases/mn-01-evm-contract-generalize/mn-01-REPORT-gateB.md` covering the 7-cat template (PLANs closed, tests green with counts, drift checks, spec-parity, rollback tag, captain verdict pending, handoff updated). Then captain-proxy emits `mn-01-CAPTAIN-GATE-B-VERDICT.md`, tags `pre-mn-01-rollback` on `feat/multi-network`, and updates the cockpit handoff. **Do not push remote.**
