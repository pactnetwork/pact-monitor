# Spike 1 — Foundry bootstrap on 0G mainnet

**Proves:** A no-op contract deploys + verifies on 0G Aristotle (chain 16661) with `evm_version = cancun`.

**Why this matters:** The plan assumes Foundry, cancun EVM, and the public RPC work end-to-end. If any link breaks we discover it before writing 800 LOC of `PactCore.sol`.

## Prereqs

- `foundryup` installed (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- A funded mainnet wallet (~0.05 0G is plenty for one `Hello` deploy)

## Run

```bash
cd spikes/foundry-bootstrap

# install forge-std
forge install foundry-rs/forge-std --no-commit

# load env
cp .env.example .env
# edit .env: set DEPLOYER_PK (no 0x prefix is fine for foundry's envUint)

# compile (this alone validates the cancun pin)
forge build

# dry-run the deploy locally
forge script script/Deploy.s.sol --rpc-url $RPC_URL

# real deploy
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# verify on explorer (if forge etherscan integration works against chainscan)
# forge verify-contract <ADDRESS> src/Hello.sol:Hello \
#   --chain-id 16661 \
#   --verifier-url https://chainscan.0g.ai/api \
#   --etherscan-api-key $ZEROG_EXPLORER_API_KEY \
#   --constructor-args $(cast abi-encode "constructor(string)" "hello 0g")
```

## Pass criteria

- `forge build` succeeds with no cancun-related warnings.
- `forge script ... --broadcast` returns a tx hash that resolves on `https://chainscan.0g.ai/tx/<hash>`.
- The deployed address shows the `Hello` bytecode and `message() → "hello 0g"` via `cast call`.
- `forge verify-contract` succeeds and shows verified source on the explorer. **If verify fails, document the exact error** — the submission requires verified contracts on mainnet.

## Fail signals worth noting

- Invalid-opcode revert at construction → cancun pin not actually applied, or 0G EVM is on an older fork. Try `evm_version = "shanghai"` or `"paris"`.
- `forge verify` rejects the API URL → 0G Explorer's verification path isn't Etherscan-compatible. Need to find the actual verifier endpoint (check docs.0g.ai).
- RPC connection refused under any load → switch to a paid RPC immediately.

## Outcome to record back in the plan

Update [spikes/README.md](../README.md) status, and write a short note in
[../inft-erc7857/README.md](../inft-erc7857/README.md)-style format (file
created after this spike runs) with: the deployed `Hello` address on mainnet,
the explorer link, whether `forge verify` worked, and any gotchas.
