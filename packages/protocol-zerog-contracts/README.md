# @pact-network/protocol-zerog-contracts

Solidity contracts for Pact-0G on 0G Chain.

## Contracts

| Contract | Status | Purpose |
|---|---|---|
| [`PactCore.sol`](src/PactCore.sol) | ✅ ready (54/54 tests, 100% line + branch coverage) | Insurance core — per-endpoint pools, premium debit, breach refund, fee splits |
| [`MockUsdc.sol`](src/MockUsdc.sol) | ✅ ready | Demo stablecoin (6 decimals matching real USDC). Owner-mintable. |
| [`MockUsdcFaucet.sol`](src/MockUsdcFaucet.sol) | ✅ ready | Rate-limited public faucet for `MockUsdc`. After deploy, `MockUsdc.transferOwnership(faucet)` so `drip()` can mint. Drip 1000 mUSDC / 24h per address by default. |
| `EndpointINFT.sol` | ⏳ not started | ERC-7857 INFT minted per insured endpoint. Fork [`0gfoundation/0g-agent-nft@main`](https://github.com/0gfoundation/0g-agent-nft). Trim per [spikes/inft-erc7857/README.md](../../spikes/inft-erc7857/README.md). |
| `AlwaysOkVerifier.sol` | ⏳ not started | Stub `IERC7857DataVerifier` (at `contracts/interfaces/`) for `EndpointINFT.mint`. Always returns true. |

## Reference

The 1:1 porting target is the Pinocchio v1 program — copy semantics, not syntax.

- [Pinocchio v1 program (Rust)](../program/programs-pinocchio/pact-network-v1-pinocchio/)
- [`settle_batch.rs`](../program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs) — most important file
- [`state.rs`](../program/programs-pinocchio/pact-network-v1-pinocchio/src/state.rs) — account layouts
- [`constants.rs`](../program/programs-pinocchio/pact-network-v1-pinocchio/src/constants.rs) — `MAX_BATCH_SIZE = 50`, `DEFAULT_MAX_TOTAL_FEE_BPS = 3000`, `MIN_PREMIUM_LAMPORTS = 100`

## Documented v1 divergences (intentional)

- **`SettlementStatus` discriminants shifted +1** — EVM needs `Unsettled = 0` as the dedup sentinel in `callStatus`. v1 has `Settled = 0`. Indexer ABI uses EVM values.
- **`topUpCoveragePool` is permissionless** — v1 gates on `coverage_pool.authority`. Topup is monotonically additive, no security gain from gating.
- **`RecipientPaid` event** — emitted per fee transfer so the indexer can derive earnings from logs alone; v1 has no such event.
- **UUID → `bytes16 callId` encoding** — settler MUST use `bytes16(bytes32(uuid_hex_padded_right))` (HIGH 16 bytes). The naive `bytes16(uint128(uint256(...)))` takes the LOW 128 bits (wrong half). Round-trip test lives in `protocol-zerog-client/src/types.ts`.

## Prereqs

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (tested with 1.7.1)

```bash
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1
forge install foundry-rs/forge-std@v1.14.0
# Optional, for INFT step:
forge install 0gfoundation/0g-agent-nft
```

Note: forge 1.7+ defaults to no-commit; the `--no-commit` flag was removed.

## Build & test

```bash
forge build
forge test -vv
forge coverage --ir-minimum --report summary
forge fmt
```

Current coverage gate (PactCore + MockUsdc + Faucet): **100% lines, branches, functions.**

## Deploy (Galileo testnet)

```bash
cp .env.example .env
# Required: DEPLOYER_PK
# Optional: ADMIN_ADDR, SETTLER_ADDR, TREASURY_ADDR (default: deployer)
# Optional: FAUCET_DRIP_AMOUNT (default 1000e6), FAUCET_COOLDOWN_SECONDS (default 86400)

forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
```

The script deploys in this order:
1. `MockUsdc(deployer)` — deployer owns initially so test setup can mint
2. `MockUsdcFaucet(usdc, drip, cooldown)`
3. `usdc.transferOwnership(faucet)` — only faucet can mint from here on
4. `PactCore(admin, settler, treasury, usdc)`

After ownership transfer the deployer can no longer mint mUSDC directly — drain via `faucet.drip()`.

### Verify on Chainscan

```bash
# Testnet
forge verify-contract <ADDRESS> src/PactCore.sol:PactCore \
  --chain-id 16602 \
  --verifier custom \
  --verifier-url https://chainscan-galileo.0g.ai/open/api \
  --etherscan-api-key $ZEROG_EXPLORER_API_KEY

# Mainnet (Day 18)
forge verify-contract <ADDRESS> src/PactCore.sol:PactCore \
  --chain-id 16661 \
  --verifier custom \
  --verifier-url https://chainscan.0g.ai/open/api \
  --etherscan-api-key $ZEROG_EXPLORER_API_KEY
```

`/open/api` is the verifier endpoint — `/api` returns the React SPA HTML.

## EVM version

Pinned to `cancun` in `foundry.toml` (the cancun pin survives `via_ir = true` which we use for the wide `EndpointConfig` struct). Confirmed working on Galileo per [spikes/RESULTS.md](../../spikes/RESULTS.md).

## Test scenarios

54 tests across two groups:

**T1–T26 — plan-mandated scenarios** (porting v1 LiteSVM coverage):
- T1: non-breach settle → premium − fees grows pool
- T2: breach with full pool → refund=requested, status `Settled` (NB: no `Refunded` enum)
- T3: breach with partial pool → clamped + `PoolDepleted`
- T4: exposure cap clamps refund (not premium) → `ExposureCapClamped`
- T5: duplicate `callId` reverts (v1 reverts; settler dedups pre-submit)
- T6: batch > `MAX_BATCH_SIZE` reverts
- T7–T9: fee-recipient validator (bps sum, treasury cardinality, dup destination)
- T10: non-settler caller reverts
- T11: malicious ERC20 reentry blocked by `nonReentrant` (DoS surface deferred)
- T12–T13: pause flows
- T14: gas snapshot at MAX_BATCH_SIZE=50
- T15–T17: slug validation, treasury bps zero, re-register
- T18: `updateEndpointConfig` persists zero values (present-flag pattern)
- T19: missing approval → `DelegateFailed`, batch continues
- T20: future timestamp reverts
- T21: premium below `MIN_PREMIUM` reverts
- T22: empty batch is a no-op
- T23: `recipientEarnings` accumulator across records in one batch
- T24: `topUpCoveragePool` succeeds while endpoint paused
- T25: gas snapshot at MIN batch (1 record, 8 recipients)
- T26: slug with NUL in middle ok; high-bit byte rejected

**C1–C19 — branch-coverage tests** (auth failures, validator edge cases, exposure-cap window + disabled paths, `DelegateFailed` via `returns(false)`, Faucet drip + cooldown, `decimals()`, set-all config fields).

## Verified deployment record

When deploys happen, pin the addresses here so off-chain packages can import them via `@pact-network/shared/zerog.ts`.

| Contract | Address (Galileo testnet, chain 16602) | Address (Aristotle mainnet, chain 16661) |
|---|---|---|
| `PactCore` | TBD | TBD |
| `MockUsdc` | TBD | TBD |
| `MockUsdcFaucet` | TBD | TBD |
| `EndpointINFT` | TBD | TBD |
| `AlwaysOkVerifier` | TBD | TBD |

Verification status: TBD.
