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

## WP-EVM-03 — PactPool (scoped; detailed plan authored at turn)

**Deliverable:** `PactPool.sol` full logic + ported `tests/01-pool.test.ts`.
**Source of truth:** `src/instructions/top_up_coverage_pool.rs`, `state.rs` `CoveragePool`. **Parity invariants:** `topUp` pulls `amount` USDC funder→pool via `transferFrom`, `currentBalance += amount`, `totalDeposits += amount` (checked add → `ArithmeticOverflow`); `balanceOf` returns `PoolState`; settler-gated internal `debit/credit/refund` (consumed by WP-04). **Tests:** every `tests/01-pool.test.ts` scenario ported with identical balance assertions. **Acceptance:** `forge test` green; pool accounting bit-identical to Solana.

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
