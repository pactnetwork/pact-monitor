# @pact-network/protocol-zerog-contracts

Solidity contracts for Pact-0G on 0G Chain.

## Contracts

| Contract | Status | Purpose |
|---|---|---|
| [`PactCore.sol`](src/PactCore.sol) | 🚧 skeleton — state/sigs/events final, bodies stubbed | Insurance core — per-endpoint pools, premium debit, breach refund, fee splits |
| [`MockUsdc.sol`](src/MockUsdc.sol) | ✅ ready | Demo stablecoin (6 decimals matching real USDC). Owner-mintable. |
| [`MockUsdcFaucet.sol`](src/MockUsdcFaucet.sol) | ✅ ready | Rate-limited public faucet for `MockUsdc`. Owner of `MockUsdc` must be set to the faucet for `drip()` to mint. |
| `EndpointINFT.sol` | ⏳ not started | ERC-7857 INFT minted per insured endpoint. Fork [`0gfoundation/0g-agent-nft@eip-7857-draft`](https://github.com/0gfoundation/0g-agent-nft/tree/eip-7857-draft). Trim per [spikes/inft-erc7857/README.md](../../spikes/inft-erc7857/README.md). |
| `AlwaysOkVerifier.sol` | ⏳ not started | Stub `IERC7857DataVerifier` for `EndpointINFT.mint`. Always returns true. |

## Reference

The 1:1 porting target is the Pinocchio v1 program — copy semantics, not syntax.
The plan's `settleBatch` pseudocode is mirrored verbatim as comments inside `PactCore.sol`.

- [Pinocchio v1 program (Rust)](../program/programs-pinocchio/pact-network-v1-pinocchio/)
- [`settle_batch.rs`](../program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs) — most important file
- [`state.rs`](../program/programs-pinocchio/pact-network-v1-pinocchio/src/state.rs) — account layouts
- [`constants.rs`](../program/programs-pinocchio/pact-network-v1-pinocchio/src/constants.rs) — `MAX_BATCH_SIZE = 50`, `DEFAULT_MAX_TOTAL_FEE_BPS = 3000`

## Prereqs

- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- OpenZeppelin and forge-std installed under `lib/` (commands below)

```bash
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install foundry-rs/forge-std --no-commit
forge install 0gfoundation/0g-agent-nft@eip-7857-draft --no-commit
```

## Build & test

```bash
pnpm build      # forge build
pnpm test       # forge test -vv
pnpm coverage   # forge coverage — gate >=90% on PactCore.sol + EndpointINFT.sol
pnpm fmt        # forge fmt
```

## Deploy (Galileo testnet)

```bash
cp .env.example .env
# edit .env: DEPLOYER_PK

forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

Day 18 (mainnet): uncomment the mainnet block in `.env` and re-run.

## EVM version

Pinned to `cancun` in `foundry.toml`. Confirmed working on Galileo (chain 16602) per [spikes/RESULTS.md](../../spikes/RESULTS.md) — `Hello.sol` deploy via this exact config.

## Test plan (per the plan's verification section)

- Premium debit grows pool by `premium − Σ feeCuts`
- Breach refund clamps to pool balance; `Refunded` for full, `PoolDepleted` for partial
- Exposure cap clamps + stamps `ExposureCapClamped`
- Duplicate `callId` is silently skipped (matches v1's idempotent batch semantics)
- `MAX_BATCH_SIZE+1` reverts with `BatchTooLarge`
- `MAX_TOTAL_FEE_BPS+1` recipients revert with `BpsSumExceedsCap`
- Two `Treasury`-kind recipients revert with `TreasuryCardinalityViolation`
- Non-`settlementAuthority` caller of `settleBatch` reverts with `Unauthorized`
- Malicious ERC20 fee recipient cannot reenter `settleBatch`
- `pauseProtocol` blocks all settles; `pauseEndpoint` blocks one endpoint, others continue

## Verified deployment record

When mainnet deploy happens, pin the addresses here so off-chain packages can import them via `@pact-network/shared/zerog.ts`.

| Contract | Address (testnet) | Address (mainnet) |
|---|---|---|
| `PactCore` | TBD | TBD |
| `EndpointINFT` | TBD | TBD |
| `AlwaysOkVerifier` | TBD | TBD |
| `MockUsdc` | TBD | TBD |
| `MockUsdcFaucet` | TBD | TBD |
