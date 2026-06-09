# Arc EVM Parity Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Solana `pact-network-v1-pinocchio` program to Circle Arc (EVM) at full behavioral parity, verified by a Foundry suite mirroring the 10 Solana LiteSVM test files.

**Architecture:** Three contracts + one library + errors/events in `packages/program-evm/protocol-evm-v1/` (Foundry), plus a `@pact-network/protocol-evm-v1-client` TS package. Behavioral port, EVM-idiomatic mechanism — economic math bit-identical to Solana; mechanism uses ERC-20 allowance, slug-keyed mappings, first-class events, OZ AccessControl/Pausable. Spec: `docs/superpowers/specs/2026-05-15-arc-parity-port-design.md`.

**Tech Stack:** Solidity 0.8.30 (Prague), Foundry (forge), OpenZeppelin Contracts, forge-std; TS client via viem.

---

## Master plan — WP sequence

Each WP is independently working/testable software and gets executed as one crew task on `feat/arc-protocol-v1`. WP-02→05 are sequential (each builds on prior contract state). This document fully details **WP-EVM-02**; WP-03→06 are specified below as scoped work packages and get their own detailed plan authored at their turn (WP-04/05 via GSD per spec §8 — they are too complex for one-shot bite-sizing here and the spec explicitly chose GSD for them).

| WP | Deliverable | Plan |
|----|-------------|------|
| EVM-02 | Errors, events, ArcConfig, FeeValidation lib, PactRegistry + ported registry/treasury/protocol-config tests | **Detailed below** |
| EVM-03 | PactPool full logic + ported pool tests | Authored at turn |
| EVM-04 | PactSettler happy path + ported settle-batch tests | GSD at turn |
| EVM-05 | Settler hardening (exposure cap, pool-depleted, kill switches) + ported pause/exposure tests | GSD at turn |
| EVM-06 | `@pact-network/protocol-evm-v1-client` + consolidated fuzz/gas suite + parity matrix doc | Authored at turn |

Source of truth for every port task: `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/` and `…/tests/`. Parity spec: §3 invariants + §4 divergence ledger of the design spec.

---

## File Structure (WP-EVM-02)

- Create: `packages/program-evm/protocol-evm-v1/src/errors/PactErrors.sol` — every `PactError` variant as a Solidity custom error
- Create: `packages/program-evm/protocol-evm-v1/src/PactEvents.sol` — shared event declarations
- Modify: `packages/program-evm/protocol-evm-v1/src/ArcConfig.sol` — add ported `constants.rs` values
- Create: `packages/program-evm/protocol-evm-v1/src/libraries/FeeValidation.sol` — port of `fee.rs`
- Modify: `packages/program-evm/protocol-evm-v1/src/PactRegistry.sol` — full logic (replace WP-EVM-01 stubs)
- Modify: `packages/program-evm/protocol-evm-v1/src/interfaces/IPactRegistry.sol` — final shapes
- Create: `packages/program-evm/protocol-evm-v1/test/FeeValidation.t.sol`
- Create: `packages/program-evm/protocol-evm-v1/test/PactRegistry.t.sol`
- Create: `packages/program-evm/protocol-evm-v1/test/util/MockUSDC.sol` — 6-decimal ERC-20 test token
- Modify: `packages/program-evm/protocol-evm-v1/foundry.toml` — OZ + forge-std remappings
- Modify: `packages/program-evm/protocol-evm-v1/.gitmodules` (via `forge install`)

---

## Task 1: Toolchain — OpenZeppelin + forge-std

**Files:**
- Modify: `packages/program-evm/protocol-evm-v1/foundry.toml`
- Create: `packages/program-evm/protocol-evm-v1/test/util/MockUSDC.sol`

- [ ] **Step 1: Install dependencies**

Run from `packages/program-evm/protocol-evm-v1/`:
```bash
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
```
Expected: `lib/forge-std` and `lib/openzeppelin-contracts` created.

- [ ] **Step 2: Wire remappings**

Replace the `remappings = []` line in `foundry.toml` with:
```toml
remappings = [
  "forge-std/=lib/forge-std/src/",
  "@openzeppelin/=lib/openzeppelin-contracts/"
]
```

- [ ] **Step 3: Create the 6-decimal mock USDC**

Create `test/util/MockUSDC.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6-decimal ERC-20 standing in for Arc USDC in tests. Mirrors the
///         Solana 6-decimal USDC mint so ported assertions use identical units.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
```

- [ ] **Step 4: Verify toolchain compiles**

Run: `forge build`
Expected: PASS (existing WP-EVM-01 stubs + MockUSDC compile with OZ available).

- [ ] **Step 5: Commit**

```bash
git add foundry.toml lib .gitmodules test/util/MockUSDC.sol
git commit -m "chore(protocol-evm-v1): add OpenZeppelin + forge-std, 6-dec MockUSDC (WP-EVM-02)"
```

---

## Task 2: Port constants (`constants.rs` → `ArcConfig.sol`)

**Files:**
- Modify: `packages/program-evm/protocol-evm-v1/src/ArcConfig.sol`
- Test: `packages/program-evm/protocol-evm-v1/test/PactRegistry.t.sol` (created Task 5; constant pins added here as a standalone test file first)
- Create: `packages/program-evm/protocol-evm-v1/test/ArcConstants.t.sol`

Source of truth: `src/constants.rs` — `MAX_BATCH_SIZE=50`, `MIN_PREMIUM_LAMPORTS=100`, `MAX_FEE_RECIPIENTS=8`, `ABSOLUTE_FEE_BPS_CAP=10_000`, `DEFAULT_MAX_TOTAL_FEE_BPS=3_000`.

- [ ] **Step 1: Write the failing test**

Create `test/ArcConstants.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ArcConfig} from "../src/ArcConfig.sol";

contract ArcConstantsTest is Test {
    function test_PortedConstantsMatchSolana() public pure {
        assertEq(ArcConfig.MAX_BATCH_SIZE, 50, "MAX_BATCH_SIZE");
        assertEq(ArcConfig.MIN_PREMIUM, 100, "MIN_PREMIUM");
        assertEq(ArcConfig.MAX_FEE_RECIPIENTS, 8, "MAX_FEE_RECIPIENTS");
        assertEq(ArcConfig.ABSOLUTE_FEE_BPS_CAP, 10_000, "ABSOLUTE_FEE_BPS_CAP");
        assertEq(ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS, 3_000, "DEFAULT_MAX_TOTAL_FEE_BPS");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-contract ArcConstantsTest -vv`
Expected: FAIL — `ArcConfig.MAX_BATCH_SIZE` undefined.

- [ ] **Step 3: Add constants to ArcConfig.sol**

Insert into the `library ArcConfig` body (after the existing Arc network constants):
```solidity
    // --- Ported from Solana constants.rs (parity invariants, design spec §3) ---
    uint16 internal constant MAX_BATCH_SIZE = 50;
    uint64 internal constant MIN_PREMIUM = 100;
    uint8 internal constant MAX_FEE_RECIPIENTS = 8;
    uint16 internal constant ABSOLUTE_FEE_BPS_CAP = 10_000;
    uint16 internal constant DEFAULT_MAX_TOTAL_FEE_BPS = 3_000;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-contract ArcConstantsTest -vv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ArcConfig.sol test/ArcConstants.t.sol
git commit -m "feat(protocol-evm-v1): port constants.rs to ArcConfig (WP-EVM-02)"
```

---

## Task 3: Errors (`error.rs` → `PactErrors.sol`)

**Files:**
- Create: `packages/program-evm/protocol-evm-v1/src/errors/PactErrors.sol`

Source of truth: `src/error.rs` (variants 6000–6032). Numeric codes do NOT carry; names + trigger conditions do (design spec §3).

- [ ] **Step 1: Create the custom error file**

Create `src/errors/PactErrors.sol` with one custom error per `PactError` variant:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Solidity custom errors mirroring Solana `PactError` (error.rs
///         6000-6032). Numeric codes are not preserved; names and trigger
///         conditions are (design spec §3). Variants that lose meaning on
///         EVM (InvalidAffiliateAta, FeeRecipientInvalidUsdcMint) are kept
///         declared for the parity matrix but become unreachable (§4 #7).
error InsufficientBalance();
error EndpointPaused();
error ExposureCapExceeded();
error UnauthorizedSettler();
error UnauthorizedAuthority();
error DuplicateCallId();
error EndpointNotFound();
error PoolDepleted();
error InvalidTimestamp();
error BatchTooLarge();
error PremiumTooSmall();
error InvalidSlug();
error ArithmeticOverflow();
error FeeRecipientArrayTooLong();
error FeeBpsExceedsCap();
error FeeRecipientDuplicateDestination();
error FeeRecipientInvalidUsdcMint();
error MultipleTreasuryRecipients();
error RecipientCoverageMismatch();
error ProtocolConfigNotInitialized();
error TreasuryNotInitialized();
error EndpointAlreadyRegistered();
error InvalidFeeRecipientKind();
error InvalidProtocolConfig();
error InvalidTreasury();
error MissingTreasuryEntry();
error TreasuryBpsZero();
error InvalidAffiliateAta();
error ProtocolPaused();
```

- [ ] **Step 2: Verify it compiles**

Run: `forge build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/errors/PactErrors.sol
git commit -m "feat(protocol-evm-v1): port PactError variants to custom errors (WP-EVM-02)"
```

---

## Task 4: Events (`PactEvents.sol`)

**Files:**
- Create: `packages/program-evm/protocol-evm-v1/src/PactEvents.sol`

Source of truth: design spec §4 #3 + PR #201 §3.1/§3.3 event sketches. Events are an EVM-idiomatic addition (Solana emits none); they back the indexer.

- [ ] **Step 1: Create the events file**

Create `src/PactEvents.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Protocol events. Solana emits none; these are the EVM-idiomatic
///         on-chain truth source for the indexer (design spec §4 #3).
interface PactEvents {
    event EndpointRegistered(bytes16 indexed slug);
    event EndpointConfigUpdated(bytes16 indexed slug);
    event EndpointPaused(bytes16 indexed slug, bool paused);
    event ProtocolPaused(bool paused);
    event FeeRecipientsUpdated(bytes16 indexed slug);
    event PoolToppedUp(bytes16 indexed slug, address indexed funder, uint64 amount);
    event CallSettled(
        bytes16 indexed callId,
        bytes16 indexed slug,
        address indexed agent,
        uint64 premium,
        uint64 refund,
        uint64 actualRefund,
        uint8 status,
        bool breach,
        uint32 latencyMs,
        uint64 timestamp
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `forge build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/PactEvents.sol
git commit -m "feat(protocol-evm-v1): declare protocol events (WP-EVM-02)"
```

---

## Task 5: FeeValidation library (`fee.rs` → `FeeValidation.sol`)

**Files:**
- Create: `packages/program-evm/protocol-evm-v1/src/libraries/FeeValidation.sol`
- Create: `packages/program-evm/protocol-evm-v1/test/FeeValidation.t.sol`

Source of truth: `src/fee.rs` — `parse_and_validate` + `validate_post_substitution`. Per design spec §4 #7, SPL-token-account introspection (`validate_affiliate_atas`) has NO EVM equivalent: affiliate destination is a plain address; validation reduces to "non-zero, not duplicate, not aliasing Treasury". `FeeRecipientKind { Treasury=0, AffiliateAta=1, AffiliatePda=2 }` preserved on the wire/events for indexer parity.

Parity invariants this enforces (design spec §3): `count ≤ 8`; per-entry `bps ≤ 10_000`; exactly one Treasury; Treasury `bps > 0`; `sum_bps ≤ max_total_fee_bps` and `≤ 10_000`; no duplicate destinations (post-substitution).

- [ ] **Step 1: Write the failing tests**

Create `test/FeeValidation.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {FeeValidation} from "../src/libraries/FeeValidation.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import "../src/errors/PactErrors.sol";

contract FeeValidationTest is Test {
    using FeeValidation for IPactRegistry.FeeRecipient[8];

    function _rec(uint8 k, address d, uint16 b) internal pure returns (IPactRegistry.FeeRecipient memory r) {
        r.kind = k; r.destination = d; r.bps = b;
    }

    function test_AcceptsSingleTreasuryPlusAffiliate() public pure {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0xT), 1000);
        r[1] = _rec(1, address(0xA1), 500);
        uint32 sum = FeeValidation.validate(r, 2, 3000, address(0xT));
        assertEq(sum, 1500);
    }

    function test_RejectsTwoTreasury() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0xT), 1000);
        r[1] = _rec(0, address(0xT2), 500);
        vm.expectRevert(MultipleTreasuryRecipients.selector);
        FeeValidation.validate(r, 2, 3000, address(0xT));
    }

    function test_RejectsTreasuryBpsZero() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0xT), 0);
        vm.expectRevert(TreasuryBpsZero.selector);
        FeeValidation.validate(r, 1, 3000, address(0xT));
    }

    function test_RejectsMissingTreasury() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(1, address(0xA1), 500);
        vm.expectRevert(MissingTreasuryEntry.selector);
        FeeValidation.validate(r, 1, 3000, address(0xT));
    }

    function test_RejectsSumOverMaxTotal() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0xT), 2000);
        r[1] = _rec(1, address(0xA1), 2000);
        vm.expectRevert(FeeBpsExceedsCap.selector);
        FeeValidation.validate(r, 2, 3000, address(0xT));
    }

    function test_RejectsPerEntryOverAbsoluteCap() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0xT), 10001);
        vm.expectRevert(FeeBpsExceedsCap.selector);
        FeeValidation.validate(r, 1, 10000, address(0xT));
    }

    function test_RejectsDuplicateDestinationPostSubstitution() public {
        // Affiliate aliasing the treasury vault must be rejected after
        // Treasury destination is substituted (fee.rs validate_post_substitution).
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 1000);          // Treasury, wire dest unused
        r[1] = _rec(1, address(0xTV), 500);        // Affiliate == treasury vault
        vm.expectRevert(FeeRecipientDuplicateDestination.selector);
        FeeValidation.validate(r, 2, 3000, address(0xTV));
    }

    function test_RejectsCountOverMax() public {
        IPactRegistry.FeeRecipient[8] memory r;
        vm.expectRevert(FeeRecipientArrayTooLong.selector);
        FeeValidation.validate(r, 9, 3000, address(0xT));
    }

    function test_RejectsInvalidKind() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0xT), 1000);
        r[1] = _rec(3, address(0xA1), 500);
        vm.expectRevert(InvalidFeeRecipientKind.selector);
        FeeValidation.validate(r, 2, 3000, address(0xT));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract FeeValidationTest -vv`
Expected: FAIL — `FeeValidation` / `IPactRegistry.FeeRecipient` undefined.

- [ ] **Step 3: Define the FeeRecipient struct on the interface**

Replace `IPactRegistry.sol`'s `FeeRecipient` struct (keep the rest) so the library and contract share one type:
```solidity
    struct FeeRecipient {
        uint8 kind;        // 0 = Treasury, 1 = AffiliateAta, 2 = AffiliatePda
        address destination;
        uint16 bps;
    }
```

- [ ] **Step 4: Implement FeeValidation.sol**

Create `src/libraries/FeeValidation.sol`. This is the parity-critical port of `fee.rs`; the affiliate-ATA introspection is intentionally dropped per §4 #7 and the Treasury destination is substituted before the duplicate check (mirrors `substitute_treasury_destination` + `validate_post_substitution`):
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPactRegistry} from "../interfaces/IPactRegistry.sol";
import {ArcConfig} from "../ArcConfig.sol";
import "../errors/PactErrors.sol";

/// @notice Port of Solana fee.rs. Validation order and rules are parity
///         invariants (design spec §3). SPL token-account introspection
///         (fee.rs validate_affiliate_atas) is dropped — no EVM equivalent
///         (§4 #7); affiliate destination is a plain address. Treasury entry
///         destination is substituted with `treasuryVault` before the
///         duplicate check (mirrors substitute_treasury_destination +
///         validate_post_substitution).
library FeeValidation {
    /// @return sumBps total basis points across the validated recipients.
    function validate(
        IPactRegistry.FeeRecipient[8] memory recipients,
        uint8 count,
        uint16 maxTotalFeeBps,
        address treasuryVault
    ) internal pure returns (uint32 sumBps) {
        if (count > ArcConfig.MAX_FEE_RECIPIENTS) revert FeeRecipientArrayTooLong();

        uint256 treasuryCount;
        uint16 treasuryBps;
        sumBps = 0;

        for (uint256 i = 0; i < count; i++) {
            IPactRegistry.FeeRecipient memory e = recipients[i];
            if (e.kind > 2) revert InvalidFeeRecipientKind();
            if (e.bps > ArcConfig.ABSOLUTE_FEE_BPS_CAP) revert FeeBpsExceedsCap();
            if (e.kind == 0) {
                treasuryCount += 1;
                treasuryBps = e.bps;
                recipients[i].destination = treasuryVault; // substitution
            }
            sumBps += uint32(e.bps);
        }

        if (sumBps > ArcConfig.ABSOLUTE_FEE_BPS_CAP) revert FeeBpsExceedsCap();
        if (sumBps > maxTotalFeeBps) revert FeeBpsExceedsCap();
        if (treasuryCount == 0) revert MissingTreasuryEntry();
        if (treasuryCount > 1) revert MultipleTreasuryRecipients();
        if (treasuryBps == 0) revert TreasuryBpsZero();

        // Duplicate detection AFTER substitution (fee.rs validate_post_substitution).
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = 0; j < i; j++) {
                if (recipients[i].destination == recipients[j].destination) {
                    revert FeeRecipientDuplicateDestination();
                }
            }
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `forge test --match-contract FeeValidationTest -vv`
Expected: PASS (all 9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/libraries/FeeValidation.sol src/interfaces/IPactRegistry.sol test/FeeValidation.t.sol
git commit -m "feat(protocol-evm-v1): port fee.rs validation library (WP-EVM-02)"
```

---

## Task 6: PactRegistry full logic

**Files:**
- Modify: `packages/program-evm/protocol-evm-v1/src/PactRegistry.sol`
- Modify: `packages/program-evm/protocol-evm-v1/src/interfaces/IPactRegistry.sol`
- Create: `packages/program-evm/protocol-evm-v1/test/PactRegistry.t.sol`

Source of truth: `src/instructions/register_endpoint.rs`, `update_endpoint_config.rs`, `update_fee_recipients.rs`, `pause_endpoint.rs`, `pause_protocol.rs`, `initialize_protocol_config.rs`, `initialize_treasury.rs`; `state.rs` `EndpointConfig`/`ProtocolConfig`. The 3 Solana `initialize_*` instructions collapse into the constructor + setters (§4 #6). Ported test scenarios: `tests/00-protocol-config.test.ts`, `tests/00-treasury.test.ts`, `tests/02-endpoint.test.ts`, `tests/10-pause-protocol.test.ts`, `tests/06-pause.test.ts` (endpoint-pause cases).

Parity invariants: only `protocolConfig.authority` may register/update/pause; `register` rejects duplicate slug (`EndpointAlreadyRegistered`); `fee_recipients_present=0` copies `ProtocolConfig.defaultFeeRecipients`; fee arrays validated via `FeeValidation`; `paused` semantics; stats fields initialized to zero; `EndpointConfig` field set mirrors `state.rs` (`flatPremium, percentBps, slaLatencyMs, imputedCost, exposureCapPerHour`, stats, `feeRecipients[8]`, `feeRecipientCount`).

- [ ] **Step 1: Finalize IPactRegistry.sol shapes**

Set `IPactRegistry.sol` to the final interface (keeps the FeeRecipient from Task 5):
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IPactRegistry {
    struct FeeRecipient { uint8 kind; address destination; uint16 bps; }

    struct EndpointConfig {
        bool paused;
        uint64 flatPremium;
        uint16 percentBps;
        uint32 slaLatencyMs;
        uint64 imputedCost;
        uint64 exposureCapPerHour;
        uint64 totalCalls;
        uint64 totalBreaches;
        uint64 totalPremiums;
        uint64 totalRefunds;
        uint64 currentPeriodStart;
        uint64 currentPeriodRefunds;
        uint64 lastUpdated;
        uint8 feeRecipientCount;
        FeeRecipient[8] feeRecipients;
    }

    function registerEndpoint(
        bytes16 slug,
        uint64 flatPremium,
        uint16 percentBps,
        uint32 slaLatencyMs,
        uint64 imputedCost,
        uint64 exposureCapPerHour,
        bool feeRecipientsPresent,
        uint8 feeRecipientCount,
        FeeRecipient[8] calldata feeRecipients
    ) external;

    function updateEndpointConfig(
        bytes16 slug,
        uint64 flatPremium,
        uint16 percentBps,
        uint32 slaLatencyMs,
        uint64 imputedCost,
        uint64 exposureCapPerHour
    ) external;

    function updateFeeRecipients(bytes16 slug, FeeRecipient[8] calldata recipients, uint8 count) external;
    function pauseEndpoint(bytes16 slug, bool paused) external;
    function pauseProtocol(bool paused) external;

    function getEndpoint(bytes16 slug) external view returns (EndpointConfig memory);
    function isRegistered(bytes16 slug) external view returns (bool);
    function protocolPaused() external view returns (bool);
    function authority() external view returns (address);
    function treasuryVault() external view returns (address);
    function maxTotalFeeBps() external view returns (uint16);
}
```

- [ ] **Step 2: Write the failing tests (ported scenarios)**

Create `test/PactRegistry.t.sol` porting the LiteSVM scenarios (one test per Solana `test(...)`). Port each scenario from `tests/02-endpoint.test.ts`, `tests/00-protocol-config.test.ts`, `tests/00-treasury.test.ts`, `tests/10-pause-protocol.test.ts`, and the endpoint-pause cases of `tests/06-pause.test.ts`, preserving each assertion (registered fields, fee-recipient entries, revert reasons, only-authority gating, duplicate-slug rejection, default-template copy, protocol/endpoint pause toggles). Use the exact expected values from the Solana tests (e.g. default template = 1 Treasury entry @ 1000 bps; explicit recipients written verbatim; `sum > 10000` rejected). Helper `_setup()` deploys `MockUSDC`, `PactRegistry(authority, usdcAddr, treasuryVault, ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS, defaultRecipients)`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `forge test --match-contract PactRegistryTest -vv`
Expected: FAIL — registry functions revert `NOT_IMPLEMENTED`.

- [ ] **Step 4: Implement PactRegistry.sol**

Replace the WP-EVM-01 stub bodies with full logic: constructor stores `authority`, `usdc`, `treasuryVault`, `maxTotalFeeBps`, `defaultFeeRecipients[8]`/`defaultCount` (replaces `initialize_protocol_config`/`initialize_treasury`, §4 #6), `protocolPaused=false`. `onlyAuthority` modifier (`msg.sender == authority` else `UnauthorizedAuthority`). `registerEndpoint`: revert `EndpointAlreadyRegistered` if `_registered[slug]`; if `!feeRecipientsPresent` use default template else validate via `FeeValidation.validate(recipients,count,maxTotalFeeBps,treasuryVault)`; write `EndpointConfig` (stats zeroed, `lastUpdated=block.timestamp`); set `_registered[slug]=true`; `emit EndpointRegistered(slug)`. `updateEndpointConfig`/`updateFeeRecipients`/`pauseEndpoint`: require `_registered[slug]` else `EndpointNotFound`, mutate, emit. `pauseProtocol`: set flag, `emit ProtocolPaused`. View getters return stored structs.

- [ ] **Step 5: Run tests to verify they pass**

Run: `forge test --match-contract PactRegistryTest -vv`
Expected: PASS (all ported registry scenarios).

- [ ] **Step 6: Full build + suite**

Run: `forge build && forge test -vv`
Expected: PASS — all WP-EVM-02 tests green; no `NOT_IMPLEMENTED` left in PactRegistry.

- [ ] **Step 7: Commit**

```bash
git add src/PactRegistry.sol src/interfaces/IPactRegistry.sol test/PactRegistry.t.sol
git commit -m "feat(protocol-evm-v1): PactRegistry full logic + ported registry tests (WP-EVM-02)"
```

---

## Task 7: WP-EVM-02 parity self-check + PR update

**Files:** none (verification + PR)

- [ ] **Step 1: Cross-check ported scenarios**

For each of `tests/00-protocol-config.test.ts`, `tests/00-treasury.test.ts`, `tests/02-endpoint.test.ts`, `tests/10-pause-protocol.test.ts`, and the endpoint-pause cases of `tests/06-pause.test.ts`: confirm every `test(...)` has a corresponding `PactRegistryTest` function with the same assertion values. List any Solana scenario not yet ported; if any are registry-scoped, add the test and re-run before proceeding.

- [ ] **Step 2: Confirm no parity invariant skipped**

Re-read design spec §3; confirm each registry-relevant invariant (only-authority gating, duplicate-slug, default-template copy, fee validation order, pause semantics, stats zero-init) is asserted by a test.

- [ ] **Step 3: Run full build/test**

Run: `forge build && forge test`
Expected: PASS.

- [ ] **Step 4: Commit + push + update PR #204**

```bash
git push origin feat/arc-protocol-v1
gh pr comment 204 --body "WP-EVM-02 complete: errors, events, ArcConfig constants, FeeValidation lib, PactRegistry full logic. Ported registry/treasury/protocol-config/pause scenarios from LiteSVM tests; forge test green. Next: WP-EVM-03 PactPool."
```

---

## WP-EVM-03 — PactPool (DETAILED — authored at turn 2026-05-18)

> Supersedes the prior scoped stub. Source of truth: `top_up_coverage_pool.rs`,
> `state.rs` `CoveragePool`, `register_endpoint.rs` pool-creation block,
> `settle_batch.rs:360-498` (CoveragePool mutations the settler hooks mirror),
> `tests/01-pool.test.ts`. Parity governed by spec §3 + §4 ledger (#2 single
> contract w/ slug mapping, #4 uint64 widths, #5 OZ AccessControl SETTLER_ROLE,
> #8 USDC = 6-dec ERC-20). Established principle: Solana source is authority
> over any plan/spec sketch; STOP-AND-ASK on parity ambiguity.

**Goal:** Port the Solana coverage-pool layer (`top_up_coverage_pool.rs` +
`CoveragePool` accounting + the pool mutations `settle_batch.rs` performs) to
`PactPool.sol` at behavioral parity, verified by a Foundry suite mirroring
`tests/01-pool.test.ts`.

**Architecture:** Single `PactPool` contract, `mapping(bytes16 => PoolState)`
(§4 #2). The contract itself custodies USDC (it is the ERC-20
holder/spender — no per-pool vault account, §4 #2). `topUp` is gated to the
protocol authority (Solana `top_up` requires `signer == coverage_pool.authority`
where `coverage_pool.authority` = the register-time `ProtocolConfig.authority`);
EVM reads that from the immutable `PactRegistry` reference. Settler-only
accounting hooks (`creditPremium`/`debitForFees`/`debitForRefund`/`payout`)
mirror `settle_batch.rs`'s `CoveragePool` writes and are gated by OZ
`AccessControl` `SETTLER_ROLE` (§4 #5) for WP-EVM-04 to compose.

**Tech Stack:** Solidity 0.8.30, Foundry, OpenZeppelin `AccessControl` +
`SafeERC20` (installed WP-EVM-02), forge-std, MockUSDC (6-dec, WP-EVM-02).

### GATE A — design decisions & parity notes (captain reviews BEFORE any Solidity)

The Solana per-endpoint `coverage_pool` PDA does not map 1:1 to EVM; these
decisions resolve the gaps **faithfully to the Solana source**, flagged for
review:

- **D1 Pool-existence model.** Solana `register_endpoint` atomically creates
  the `coverage_pool` PDA alongside `EndpointConfig`. EVM (§4 #2) has no
  discrete account-creation: `PoolState` is a zero-initialized mapping entry.
  Decision: `PactPool` holds an **immutable `IPactRegistry registry`**;
  `topUp`/`balanceOf` require `registry.isRegistered(slug)` (else
  `EndpointNotFound`) — "pool exists ⟺ endpoint registered", exactly the
  Solana invariant, **without modifying the committed WP-EVM-02
  `PactRegistry`** (no cross-WP edit; karpathy-surgical). Default mapping
  zero-values == Solana's freshly-created pool's zeroed accounting.
- **D2 `createdAt` semantics.** Solana sets `created_at = now` at register.
  No EVM register-time pool callback (D1). Decision: `createdAt` set on first
  `topUp` if still 0. **Documented divergence — informational only**: grep
  confirms `created_at` is never read by `top_up_coverage_pool.rs` or
  `settle_batch.rs` (no behavioral parity impact; same class as §4 #4
  byte-layout note). Recorded for WP-EVM-06 parity matrix.
- **D3 `topUp` authority-gating.** `top_up_coverage_pool.rs`: `if
  &state.authority != authority.address() → UnauthorizedAuthority`. EVM:
  `if (msg.sender != registry.authority()) revert UnauthorizedAuthority()`.
  The plan/spec loose wording "funder→pool" is resolved **authority-gated per
  source** — the funder *is* the authority (Solana pulls from the authority's
  ATA); `safeTransferFrom(msg.sender, address(this), amount)`.
- **D4 Settler hooks.** Derived from `settle_batch.rs:360-498`: premium →
  `current_balance += p; total_premiums += p`; fee fan-out →
  `current_balance -= total_fee_paid`; refund → `current_balance -= r;
  total_refunds += r`; all `checked_* → PactError::ArithmeticOverflow`. WP-03
  defines `creditPremium`/`debitForFees`/`debitForRefund` + a settler-only
  `payout(to,amount)` (USDC egress for fees/refund), `SETTLER_ROLE`-gated;
  **tested in isolation here, composed by WP-EVM-04.** Signatures derived from
  source, not invented; flag if WP-04 needs refinement.
- **D5 Constructor change.** `PactPool(address usdc_)` →
  `PactPool(address usdc_, address registry_)`. Breaks `Deployment.t.sol`
  `test_DeployPactPool` (1-arg) → surgical scaffold-test fix included (same
  pattern as the WP-EVM-02 `Deployment.t.sol` fix).
- **D6 `ArithmeticOverflow` parity.** Solidity 0.8 auto-Panics on `uint64`
  overflow; Solana returns the named `PactError::ArithmeticOverflow`. To
  preserve error parity (spec §3 "every variant... triggered by the same
  condition"), use `unchecked` add/sub + manual detection →
  `revert ArithmeticOverflow()` (reachable for `uint64`, unlike the WP-02 fee
  `uint32` sum which was provably unreachable).

### PORT / N-A-on-EVM split — `tests/01-pool.test.ts` (4 scenarios)

| Solana scenario | Disposition |
|---|---|
| `register_endpoint creates per-slug coverage pool with correct state` | **PARTIAL PORT** → after `registerEndpoint`, `balanceOf(slug)` returns zeroed accounting (`currentBalance==0`, `totalDeposits==0`) and `isRegistered(slug)`. **N/A sub-assertions** (§4 #2/#4 platform layout): `bump>0` (no PDA bump), `authority`-bytes@8 (authority is `registry.authority()`, not in `PoolState`), `slug`-bytes@104 (slug is the mapping key, not stored) |
| `two endpoints have isolated coverage pools at distinct PDAs` | **PORT (behavior)** → two slugs → independent `PoolState`; `topUp(A)` does not affect B. **N/A**: "distinct PDAs/vaults" (§4 #2 — mapping keys inherently distinct; the contract is the single vault) |
| `top_up_coverage_pool credits only the targeted slug pool` | **FULL PORT** → identical balance assertions: `balanceOf(A).currentBalance == 500_000`, pool USDC balance `== 500_000`, `balanceOf(B).currentBalance == 0` |
| `top_up rejects mismatched pool/slug pair (slug seed != pool PDA)` | **N/A-ON-EVM** → Solana PDA-derivation mechanic (`derive_coverage_pool(slug) != pool.address → InvalidSeeds`); §4 #2 single-contract mapping makes a pool/slug mismatch structurally impossible (slug *is* the key). **Residual EVM-meaningful behavior** ported instead: `topUp` on an unregistered slug → `EndpointNotFound` |

Parity-invariant adds from `top_up_coverage_pool.rs` (no dedicated LiteSVM
scenario, but source-enforced): non-authority caller → `UnauthorizedAuthority`;
`checked_add` overflow → `ArithmeticOverflow`; `safeTransferFrom` failure
(insufficient balance/allowance) reverts the whole `topUp`.

### File Structure (WP-EVM-03)

- Modify: `src/interfaces/IPactPool.sol` — finalize (add settler hooks, getters); `PoolState` verified == `CoveragePool` mutable accounting (no field change)
- Modify: `src/PactPool.sol` — full logic (replace WP-EVM-01 stubs)
- Modify: `test/Deployment.t.sol` — `test_DeployPactPool` → 2-arg constructor (D5)
- Create: `test/PactPool.t.sol` — ported `01-pool.test.ts` + parity-invariant + settler-hook isolation tests
- Reuse: `test/util/MockUSDC.sol` (WP-EVM-02)

---

### Task 1: PactPool shell — registry ref, OZ AccessControl, IPactPool finalize, Deployment fix

**Files:**
- Modify: `src/interfaces/IPactPool.sol`
- Modify: `src/PactPool.sol`
- Modify: `test/Deployment.t.sol`
- Create: `test/PactPool.t.sol`

- [ ] **Step 1: Finalize IPactPool.sol**

Replace `src/interfaces/IPactPool.sol` (keep `PoolState` EXACTLY — it already
mirrors `CoveragePool` mutable accounting `{current_balance, total_deposits,
total_premiums, total_refunds, created_at}`):
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IPactPool {
    struct PoolState {
        uint64 currentBalance;
        uint64 totalDeposits;
        uint64 totalPremiums;
        uint64 totalRefunds;
        uint64 createdAt;
    }

    event PoolToppedUp(bytes16 indexed slug, address indexed funder, uint64 amount);

    function topUp(bytes16 slug, uint64 amount) external;
    function balanceOf(bytes16 slug) external view returns (PoolState memory);

    // Settler-gated accounting hooks (SETTLER_ROLE, §4 #5) — composed by WP-EVM-04.
    function creditPremium(bytes16 slug, uint64 amount) external;
    function debitForFees(bytes16 slug, uint64 amount) external;
    function debitForRefund(bytes16 slug, uint64 amount) external;
    function payout(address to, uint64 amount) external;
}
```

- [ ] **Step 2: Write the failing deploy test**

Create `test/PactPool.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PactPool} from "../src/PactPool.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {IPactPool} from "../src/interfaces/IPactPool.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {ArcConfig} from "../src/ArcConfig.sol";
import {MockUSDC} from "./util/MockUSDC.sol";
import "../src/errors/PactErrors.sol";

contract PactPoolTest is Test {
    MockUSDC usdc;
    PactRegistry reg;
    PactPool pool;

    address authority = makeAddr("authority");
    address treasuryVault = makeAddr("treasuryVault");
    address settler = makeAddr("settler");
    address funder = makeAddr("funder");
    bytes16 constant SLUG = bytes16("helius");
    bytes16 constant SLUG_B = bytes16("jupiter");

    function setUp() public {
        usdc = new MockUSDC();
        IPactRegistry.FeeRecipient[8] memory d;
        d[0].kind = 0;
        d[0].destination = treasuryVault;
        d[0].bps = 1000;
        reg = new PactRegistry(
            authority, address(usdc), treasuryVault, ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS, d, 1
        );
        pool = new PactPool(address(usdc), address(reg));
    }

    function _register(bytes16 slug) internal {
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(slug, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
    }

    function test_Deploy_WiresUsdcRegistryAndAdmin() public view {
        assertEq(pool.usdc(), address(usdc));
        assertEq(address(pool.registry()), address(reg));
        // DEFAULT_ADMIN_ROLE granted to registry.authority(); SETTLER_ROLE not yet granted.
        assertTrue(pool.hasRole(0x00, authority));
        assertFalse(pool.hasRole(pool.SETTLER_ROLE(), settler));
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run from `packages/program-evm/protocol-evm-v1/`:
`forge test --match-contract PactPoolTest -vv`
Expected: FAIL — `PactPool` constructor is 1-arg / `registry()` / `SETTLER_ROLE` undefined.

- [ ] **Step 4: Implement the PactPool shell**

Replace `src/PactPool.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPactPool} from "./interfaces/IPactPool.sol";
import {IPactRegistry} from "./interfaces/IPactRegistry.sol";
import "./errors/PactErrors.sol";

/// @title PactPool
/// @notice One-per-chain USDC coverage-pool vault, keyed by 16-byte `slug`
///         (§4 #2). EVM analogue of the Solana `CoveragePool` PDA. The
///         contract custodies USDC directly (it is the ERC-20 holder/spender).
/// @dev Behavioral port of top_up_coverage_pool.rs + the CoveragePool
///      mutations of settle_batch.rs. Pool exists ⟺ endpoint registered
///      (registry.isRegistered). Authority/role model: §4 #5.
contract PactPool is IPactPool, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    IERC20 private immutable _usdc;
    IPactRegistry public immutable registry;

    mapping(bytes16 => PoolState) private _pools;

    constructor(address usdc_, address registry_) {
        _usdc = IERC20(usdc_);
        registry = IPactRegistry(registry_);
        // Protocol authority administers roles (grants SETTLER_ROLE to the
        // WP-EVM-04 settler post-deploy). registry.authority() is set once in
        // the PactRegistry constructor with no setter — effectively immutable.
        _grantRole(DEFAULT_ADMIN_ROLE, registry.authority());
    }

    function usdc() external view returns (address) {
        return address(_usdc);
    }

    /// @inheritdoc IPactPool
    function topUp(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function balanceOf(bytes16) external view override returns (PoolState memory) {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function creditPremium(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function debitForFees(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function debitForRefund(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function payout(address, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }
}
```

- [ ] **Step 5: Fix Deployment.t.sol (D5)**

In `test/Deployment.t.sol` `test_DeployPactPool`, replace
`new PactPool(ArcConfig.ARC_TESTNET_USDC)` with a 2-arg deploy. Replace the
body with:
```solidity
    function test_DeployPactPool() external {
        // WP-EVM-03 added the registry reference (§4 #2 pool-existence model).
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), ArcConfig.ARC_TESTNET_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        PactPool p = new PactPool(ArcConfig.ARC_TESTNET_USDC, address(r));
        require(address(p).code.length > 0, "pool: no bytecode");
        require(p.usdc() == ArcConfig.ARC_TESTNET_USDC, "pool: usdc not set");
    }
```
(Add `import {PactRegistry} from "../src/PactRegistry.sol";` — already imported
in `Deployment.t.sol` from the WP-EVM-02 fix; `IPactRegistry` import also
already present from WP-EVM-02. Verify and add only if missing.)

- [ ] **Step 6: Run test to verify it passes**

Run: `forge test --match-contract PactPoolTest -vv`
Expected: PASS — `test_Deploy_WiresUsdcRegistryAndAdmin`.

- [ ] **Step 7: Full build sanity**

Run: `forge build`
Expected: PASS (no `NOT_IMPLEMENTED` removed yet — stubs still compile).

- [ ] **Step 8: Commit**

```bash
git add src/interfaces/IPactPool.sol src/PactPool.sol test/Deployment.t.sol test/PactPool.t.sol
git commit -m "feat(protocol-evm-v1): PactPool shell — registry ref + SETTLER_ROLE (WP-EVM-03)"
```

---

### Task 2: `topUp` full port (`top_up_coverage_pool.rs`)

**Files:**
- Modify: `src/PactPool.sol`
- Modify: `test/PactPool.t.sol`

- [ ] **Step 1: Write the failing tests**

Append to `PactPoolTest`:
```solidity
    function test_TopUp_CreditsOnlyTargetedSlugPool() public {
        // Ported from 01-pool.test.ts "credits only the targeted slug pool"
        // — identical balance assertions.
        _register(SLUG);
        _register(SLUG_B);
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 500_000);
        vm.prank(authority);
        pool.topUp(SLUG, 500_000);

        assertEq(pool.balanceOf(SLUG).currentBalance, 500_000);
        assertEq(usdc.balanceOf(address(pool)), 500_000);
        assertEq(pool.balanceOf(SLUG_B).currentBalance, 0);
    }

    function test_TopUp_UpdatesTotalDeposits() public {
        _register(SLUG);
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 300_000);
        vm.prank(authority);
        pool.topUp(SLUG, 300_000);
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 300_000);
        assertEq(s.totalDeposits, 300_000);
    }

    function test_TopUp_RejectsNonAuthority() public {
        _register(SLUG);
        usdc.mint(funder, 1_000_000);
        vm.prank(funder);
        usdc.approve(address(pool), 500_000);
        vm.prank(funder);
        vm.expectRevert(UnauthorizedAuthority.selector);
        pool.topUp(SLUG, 500_000);
    }

    function test_TopUp_RejectsUnregisteredSlug() public {
        // EVM-meaningful residual of the N/A "mismatched pool/slug pair".
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 500_000);
        vm.prank(authority);
        vm.expectRevert(EndpointNotFound.selector);
        pool.topUp(SLUG, 500_000);
    }

    function test_TopUp_RevertsOnInsufficientAllowance() public {
        _register(SLUG);
        usdc.mint(authority, 1_000_000);
        // no approve
        vm.prank(authority);
        vm.expectRevert();
        pool.topUp(SLUG, 500_000);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract PactPoolTest -vv`
Expected: FAIL — `topUp` reverts `NOT_IMPLEMENTED`.

- [ ] **Step 3: Implement `topUp`**

In `src/PactPool.sol` replace the `topUp` stub:
```solidity
    /// @inheritdoc IPactPool
    /// @dev Port of top_up_coverage_pool.rs. Authority-gated (D3); slug must
    ///      be registered (D1); pulls `amount` USDC msg.sender→this; checked
    ///      adds → ArithmeticOverflow (D6).
    function topUp(bytes16 slug, uint64 amount) external override {
        if (msg.sender != registry.authority()) revert UnauthorizedAuthority();
        if (!registry.isRegistered(slug)) revert EndpointNotFound();

        _usdc.safeTransferFrom(msg.sender, address(this), amount);

        PoolState storage p = _pools[slug];
        uint64 newBal;
        uint64 newDep;
        unchecked {
            newBal = p.currentBalance + amount;
            newDep = p.totalDeposits + amount;
        }
        if (newBal < p.currentBalance) revert ArithmeticOverflow();
        if (newDep < p.totalDeposits) revert ArithmeticOverflow();
        p.currentBalance = newBal;
        p.totalDeposits = newDep;
        if (p.createdAt == 0) p.createdAt = uint64(block.timestamp);

        emit PoolToppedUp(slug, msg.sender, amount);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-contract PactPoolTest -vv`
Expected: PASS (deploy + 5 topUp tests). `balanceOf` tests still fail (stub) — that is expected; Task 3 implements `balanceOf`. If `balanceOf`-dependent assertions block these, implement `balanceOf` minimal first (Task 3 Step 3) — but prefer running only the non-balanceOf tests here: `forge test --match-test test_TopUp_RejectsNonAuthority` etc. (the credit/deposit tests need `balanceOf`; defer their green to Task 3 Step 4 and assert here only the revert tests).

> Note: `test_TopUp_CreditsOnlyTargetedSlugPool` / `_UpdatesTotalDeposits`
> depend on `balanceOf`. Run the revert-only tests green here
> (`--match-test "RejectsNonAuthority|RejectsUnregisteredSlug|RevertsOnInsufficientAllowance"`);
> the balance-assert tests go green at Task 3 Step 4.

- [ ] **Step 5: Commit**

```bash
git add src/PactPool.sol test/PactPool.t.sol
git commit -m "feat(protocol-evm-v1): port top_up_coverage_pool.rs to PactPool.topUp (WP-EVM-03)"
```

---

### Task 3: `balanceOf` + ported register/isolation scenarios

**Files:**
- Modify: `src/PactPool.sol`
- Modify: `test/PactPool.t.sol`

- [ ] **Step 1: Write the failing tests**

Append to `PactPoolTest`:
```solidity
    function test_BalanceOf_RegisteredPoolZeroInitialised() public {
        // Ported (parity subset) from 01-pool.test.ts "register_endpoint
        // creates per-slug coverage pool with correct state".
        _register(SLUG);
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 0);
        assertEq(s.totalDeposits, 0);
        assertEq(s.totalPremiums, 0);
        assertEq(s.totalRefunds, 0);
    }

    function test_BalanceOf_RevertsUnregistered() public {
        vm.expectRevert(EndpointNotFound.selector);
        pool.balanceOf(SLUG);
    }

    function test_TwoEndpointsIsolatedPools() public {
        // Ported (behavior) from 01-pool.test.ts "two endpoints have isolated
        // coverage pools".
        _register(SLUG);
        _register(SLUG_B);
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 400_000);
        vm.prank(authority);
        pool.topUp(SLUG, 400_000);
        assertEq(pool.balanceOf(SLUG).currentBalance, 400_000);
        assertEq(pool.balanceOf(SLUG_B).currentBalance, 0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract PactPoolTest -vv`
Expected: FAIL — `balanceOf` reverts `NOT_IMPLEMENTED`.

- [ ] **Step 3: Implement `balanceOf`**

In `src/PactPool.sol` replace the `balanceOf` stub:
```solidity
    /// @inheritdoc IPactPool
    /// @dev Pool exists ⟺ endpoint registered (D1) — mirrors Solana
    ///      `top_up`'s pool-account existence requirement.
    function balanceOf(bytes16 slug) external view override returns (PoolState memory) {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        return _pools[slug];
    }
```

- [ ] **Step 4: Run the full PactPool suite**

Run: `forge test --match-contract PactPoolTest -vv`
Expected: PASS — all Task 2 balance-assert tests + Task 3 tests now green.

- [ ] **Step 5: Commit**

```bash
git add src/PactPool.sol test/PactPool.t.sol
git commit -m "feat(protocol-evm-v1): PactPool.balanceOf + ported register/isolation scenarios (WP-EVM-03)"
```

---

### Task 4: `ArithmeticOverflow` parity on `topUp` (D6)

**Files:**
- Modify: `test/PactPool.t.sol`

(`topUp` already implements the `unchecked` + manual-detect overflow guard in
Task 2 Step 3 — this task proves it with a test pinning the named error vs a
Solidity Panic.)

- [ ] **Step 1: Write the failing/﻿proving test**

Append to `PactPoolTest`:
```solidity
    function test_TopUp_OverflowRevertsArithmeticOverflow() public {
        _register(SLUG);
        uint64 max = type(uint64).max;
        usdc.mint(authority, uint256(max) + 1);
        vm.startPrank(authority);
        usdc.approve(address(pool), uint256(max) + 1);
        pool.topUp(SLUG, max);            // currentBalance = 2^64-1
        vm.expectRevert(ArithmeticOverflow.selector);
        pool.topUp(SLUG, 1);              // overflow → named error, not Panic
        vm.stopPrank();
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `forge test --match-test test_TopUp_OverflowRevertsArithmeticOverflow -vv`
Expected: PASS — second `topUp` reverts `ArithmeticOverflow` (NOT
`Panic(0x11)`). If it reverts `Panic`, the Task 2 `unchecked`+manual guard is
wrong — fix `topUp` (do not rely on Solidity auto-checked arithmetic).

- [ ] **Step 3: Commit**

```bash
git add test/PactPool.t.sol
git commit -m "test(protocol-evm-v1): pin topUp ArithmeticOverflow parity vs Solana (WP-EVM-03)"
```

---

### Task 5: Settler-gated accounting hooks (`settle_batch.rs:360-498`, §4 #5)

**Files:**
- Modify: `src/PactPool.sol`
- Modify: `test/PactPool.t.sol`

- [ ] **Step 1: Write the failing tests**

Append to `PactPoolTest`:
```solidity
    function _grantSettler() internal {
        vm.prank(authority); // DEFAULT_ADMIN_ROLE
        pool.grantRole(pool.SETTLER_ROLE(), settler);
    }

    function test_Hooks_RejectNonSettler() public {
        _register(SLUG);
        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, funder, pool.SETTLER_ROLE()
            )
        );
        pool.creditPremium(SLUG, 100);
    }

    function test_CreditPremium_AddsBalanceAndPremiums() public {
        _register(SLUG);
        _grantSettler();
        vm.prank(settler);
        pool.creditPremium(SLUG, 1000);
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 1000);
        assertEq(s.totalPremiums, 1000);
    }

    function test_DebitForFees_SubtractsBalance() public {
        _register(SLUG);
        _grantSettler();
        vm.startPrank(settler);
        pool.creditPremium(SLUG, 1000);
        pool.debitForFees(SLUG, 300);
        vm.stopPrank();
        assertEq(pool.balanceOf(SLUG).currentBalance, 700);
    }

    function test_DebitForRefund_SubtractsBalanceAddsRefunds() public {
        _register(SLUG);
        _grantSettler();
        vm.startPrank(settler);
        pool.creditPremium(SLUG, 1000);
        pool.debitForRefund(SLUG, 250);
        vm.stopPrank();
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 750);
        assertEq(s.totalRefunds, 250);
    }

    function test_DebitUnderflowRevertsArithmeticOverflow() public {
        // Solana checked_sub failure → PactError::ArithmeticOverflow.
        _register(SLUG);
        _grantSettler();
        vm.prank(settler);
        vm.expectRevert(ArithmeticOverflow.selector);
        pool.debitForFees(SLUG, 1);
    }

    function test_Payout_OnlySettler_TransfersUsdc() public {
        _register(SLUG);
        _grantSettler();
        usdc.mint(authority, 1_000);
        vm.startPrank(authority);
        usdc.approve(address(pool), 1_000);
        pool.topUp(SLUG, 1_000);
        vm.stopPrank();
        vm.prank(settler);
        pool.payout(funder, 400);
        assertEq(usdc.balanceOf(funder), 400);
        assertEq(usdc.balanceOf(address(pool)), 600);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract PactPoolTest -vv`
Expected: FAIL — hooks revert `NOT_IMPLEMENTED`.

- [ ] **Step 3: Implement the settler hooks**

In `src/PactPool.sol` replace the four hook stubs. Internal checked helpers
mirror `settle_batch.rs` (`checked_add`/`checked_sub` → `ArithmeticOverflow`):
```solidity
    function _ckAdd(uint64 a, uint64 b) private pure returns (uint64 c) {
        unchecked { c = a + b; }
        if (c < a) revert ArithmeticOverflow();
    }

    function _ckSub(uint64 a, uint64 b) private pure returns (uint64 c) {
        if (b > a) revert ArithmeticOverflow();
        unchecked { c = a - b; }
    }

    /// @inheritdoc IPactPool
    /// @dev settle_batch.rs:360-368 — current_balance += p; total_premiums += p.
    function creditPremium(bytes16 slug, uint64 amount)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        PoolState storage p = _pools[slug];
        p.currentBalance = _ckAdd(p.currentBalance, amount);
        p.totalPremiums = _ckAdd(p.totalPremiums, amount);
    }

    /// @inheritdoc IPactPool
    /// @dev settle_batch.rs:448-453 — current_balance -= total_fee_paid.
    function debitForFees(bytes16 slug, uint64 amount)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        PoolState storage p = _pools[slug];
        p.currentBalance = _ckSub(p.currentBalance, amount);
    }

    /// @inheritdoc IPactPool
    /// @dev settle_batch.rs:481-490 — current_balance -= r; total_refunds += r.
    function debitForRefund(bytes16 slug, uint64 amount)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        PoolState storage p = _pools[slug];
        p.currentBalance = _ckSub(p.currentBalance, amount);
        p.totalRefunds = _ckAdd(p.totalRefunds, amount);
    }

    /// @inheritdoc IPactPool
    /// @dev USDC egress for fee fan-out + refund (the actual SPL transfers
    ///      settle_batch.rs performs). Composed by WP-EVM-04.
    function payout(address to, uint64 amount)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        _usdc.safeTransfer(to, amount);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-contract PactPoolTest -vv`
Expected: PASS — all settler-hook tests green.

- [ ] **Step 5: Full build + suite**

Run: `forge build && forge test -vv`
Expected: PASS — all WP-EVM-03 + prior WP-EVM-02 suites green; no
`NOT_IMPLEMENTED` left in `PactPool`.

- [ ] **Step 6: Commit**

```bash
git add src/PactPool.sol test/PactPool.t.sol
git commit -m "feat(protocol-evm-v1): settler-gated pool hooks mirroring settle_batch.rs (WP-EVM-03)"
```

---

### Task 6: WP-EVM-03 parity self-check (GATE B — no push/PR until captain approves)

**Files:** none (verification)

- [ ] **Step 1: Cross-check ported scenarios**

Confirm each `tests/01-pool.test.ts` `test(...)` maps to a `PactPoolTest`
function or a documented N/A-on-EVM row in the PORT/N-A table above. Confirm
the `top_up_coverage_pool.rs` parity invariants (authority-gating,
registered-slug requirement, checked-add → `ArithmeticOverflow`, transferFrom
pull) and the `settle_batch.rs:360-498` `CoveragePool` mutations are each
asserted by a test.

- [ ] **Step 2: Confirm no §3 pool invariant skipped**

Re-read spec §3 "Stats accounting" (pool `totalDeposits / totalPremiums /
totalRefunds / currentBalance` updated with identical arithmetic and
ordering). Confirm each is asserted.

- [ ] **Step 3: Full build/test**

Run: `forge build && forge test`
Expected: PASS.

- [ ] **Step 4: GATE B report — STOP**

Report via `cockpit runtime send pact-network`: commit SHAs, suite result,
parity-fidelity summary (PactPool ↔ top_up_coverage_pool.rs /
settle_batch.rs:360-498), PORT/N-A table, deviations. **Do NOT push or
comment PR #204 until the captain approves Gate B.**

---

### Self-Review (writing-plans)

**Spec coverage:** §3 pool stats accounting → Tasks 2/5 (+self-check Task 6);
§4 #2 single-contract mapping → D1 + all tasks; §4 #4 uint64 widths →
`PoolState` (unchanged, verified); §4 #5 SETTLER_ROLE → Task 1/5; §4 #8 6-dec
USDC → MockUSDC reuse; §6 module structure (`PactPool` per-slug PoolState,
topUp, balanceOf, settler-gated debit/credit/refund) → Tasks 1-5;
`top_up_coverage_pool.rs` → Task 2; `CoveragePool` → `PoolState` (Task 1);
`settle_batch.rs:360-498` pool mutations → Task 5; `tests/01-pool.test.ts` →
PORT/N-A table + Tasks 2/3. No gap.

**Placeholder scan:** every step has concrete code/commands; no TBD/"handle
edge cases"/"similar to". The settler-hook *composition* is deliberately
WP-EVM-04 scope (flagged D4) — WP-03 ships+tests the hooks in isolation, which
is independently working/testable software (writing-plans scope check).

**Type consistency:** `IPactPool.PoolState{currentBalance,totalDeposits,
totalPremiums,totalRefunds,createdAt}` defined once (Task 1), reused
unchanged; `topUp`/`balanceOf`/`creditPremium`/`debitForFees`/
`debitForRefund`/`payout` signatures consistent across interface (Task 1) and
all call sites; `registry`/`SETTLER_ROLE`/`usdc()` names consistent Tasks
1↔2↔3↔5; `ArithmeticOverflow`/`UnauthorizedAuthority`/`EndpointNotFound` from
the WP-EVM-02 `PactErrors.sol` (30-variant set, unchanged).

## WP-EVM-04 — PactSettler happy path (GSD at turn, per spec §8)

**Deliverable:** `settleBatch` happy path + ported `tests/05-settle-batch.test.ts`.
**Source of truth:** `src/instructions/settle_batch.rs` (per-event loop). **Parity invariants (design spec §3):** batch ≤ 50; per event — `MIN_PREMIUM` floor, `timestamp ≤ now`, `feeCountHint == stored count`, dedup via `mapping(bytes16=>bool)`, premium-in `transferFrom(agent,pool,premium)` with try/catch → `DelegateFailed`, fee fan-out `premium*bps/10_000` floor div (pool keeps residual), refund on breach, `SettlementStatus`, stats, `emit CallSettled` per call, `SETTLER_ROLE` gate. Crew runs `/gsd:plan-phase` + `/gsd:execute-phase`.

## WP-EVM-05 — PactSettler hardening (GSD at turn, per spec §8)

**Deliverable:** exposure-cap clamp (`ExposureCapClamped`), pool-depleted clamp (`PoolDepleted`), protocol/endpoint kill switches, batch-limit edges + ported `tests/06-pause.test.ts`, `tests/07-exposure-cap.test.ts`, `tests/10-pause-protocol.test.ts`, `tests/09-auth-pda.test.ts` (→ `SETTLER_ROLE`). **Parity invariants:** hourly rolling window reset (`currentPeriodStart/Refunds`), clamp ordering (pool balance then exposure cap), protocol-paused fast-revert before any per-event work. GSD.

## WP-EVM-06 — TS client + consolidated suite + parity matrix (authored at turn)

**Deliverable:** `packages/protocol-evm-v1-client/` (`@pact-network/protocol-evm-v1-client`, pnpm workspace member) mirroring `protocol-v1-client` modules (`addresses.ts`, `encode.ts`, `state.ts`, `errors.ts`, `constants.ts`, `helpers.ts`, `index.ts`) via viem; consolidated forge fuzz tests (fee-split rounding, batch sizes) + `forge snapshot` gas baseline; live `IERC20(USDC).decimals()==6` assertion; parity-matrix doc marking every Solana behavior IDENTICAL / OPTIMIZED-DIVERGENCE (§4 ref) / N-A-on-EVM. **Acceptance:** client builds; full suite + fuzz green; matrix complete; corrects PR #201 §7.1.

---

## Self-Review

**Spec coverage:** spec §3 invariants → Tasks 2,5,6 + WP-03/04/05 invariant lists; §4 divergence ledger → FeeValidation §4#7 (Task 5), errors §3 unreachable note (Task 3), §4#6 collapse (Task 6), §4#1 try/catch (WP-04); §5 two-package → WP-06 client; §6 module structure → File Structure + Tasks 3-6; §7 test oracle → ported tests in every WP; §8 WP waves → Master plan table; §9 success criteria → Task 7 + per-WP acceptance. No gap.

**Placeholder scan:** WP-03→06 are deliberately scoped-not-bite-sized because spec §8 chose GSD for the complex settler WPs and each WP is independently testable software (writing-plans scope-check sanctions one plan per working subsystem); WP-02 is fully bite-sized with complete code. No "TBD/handle edge cases/similar to" inside any executable step.

**Type consistency:** `IPactRegistry.FeeRecipient {kind,destination,bps}` and `EndpointConfig` defined once (Task 5/6) and reused; `FeeValidation.validate(recipients,count,maxTotalFeeBps,treasuryVault)→uint32` signature consistent across Task 5 tests + Task 6 caller; `ArcConfig` constant names consistent Task 2↔5↔WP-04.
