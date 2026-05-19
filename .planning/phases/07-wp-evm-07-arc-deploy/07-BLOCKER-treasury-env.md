# WP-EVM-07 — STOP-AND-ASK: TREASURY_VAULT_ADDRESS missing from .env

Date: 2026-05-19
Raised at: T2 pre-flight (before dry-run, zero on-chain action taken)

## What

The C2 ratification record (07-C2-RATIFICATION.md item 2, lines 14-16 and
preconditions line 39-40) states `TREASURY_VAULT_ADDRESS` is set to the
deployer EOA address in `packages/program-evm/protocol-evm-v1/.env`.

It is NOT. A names-only inspection of that .env shows:

    ARC_TESTNET_CHAIN_ID, ARC_TESTNET_EXPLORER_URL, ARC_TESTNET_FAUCET_URL,
    ARC_TESTNET_RPC_URL, ARC_TESTNET_USDC, ARC_TESTNET_WS_URL,
    ARCSCAN_API_KEY, ARCSCAN_VERIFIER_URL, DEPLOYER_PRIVATE_KEY

`TREASURY_VAULT_ADDRESS` is absent. `DEPLOYER_PRIVATE_KEY`,
`ARC_TESTNET_RPC_URL`, `ARCSCAN_API_KEY` ARE present; .env is gitignored.

## Why this blocks

`script/Deploy.s.sol` calls `vm.envAddress("TREASURY_VAULT_ADDRESS")`. Without
the var, even the T2 dry-run reverts at env resolution before the
USDC-decimals guard. The address is baked PERMANENTLY into PactRegistry
(no setter, C2). It must be the human-ratified value, not crew-derived —
deriving `vm.addr(DEPLOYER_PRIVATE_KEY)` silently would bypass the C2
primary control (the deliberately human-set .env value), which the verdict
explicitly forbids ("human ratification is the primary control").

## Ask (one clean question)

Add to `packages/program-evm/protocol-evm-v1/.env`:

    TREASURY_VAULT_ADDRESS=<the deployer EOA address>

Per C2 ratification item 2 this is the SAME address as the deployer EOA
(`vm.addr(DEPLOYER_PRIVATE_KEY)`), a deliberate testnet simplification.
Rick/Alan (or whoever holds the key) should set it — the crew does not read
the private key to derive it (the script enforces the address(0) backstop;
the human-set value is the C2 control).

Once `TREASURY_VAULT_ADDRESS` is present in that .env, the crew resumes at
T2 with no other change. No contract change, no script change required —
the script already reads this env var as designed and ratified.

## State

STOPPED at T2 pre-flight. No dry-run run, no broadcast, no on-chain action,
no commit, no push. Awaiting `TREASURY_VAULT_ADDRESS` in the .env (or a
captain instruction to the contrary).
