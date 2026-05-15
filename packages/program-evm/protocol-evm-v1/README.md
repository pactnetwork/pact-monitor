# @pact-network/protocol-evm-v1

Pact Network's EVM protocol contracts (Foundry project) targeting **Circle
Arc Testnet**. EVM port of the Solana `pact-network-v1-pinocchio` program:
per-endpoint coverage pools, per-call premium debit, on-breach refund, and
pool / treasury / integrator fee splits.

> **SCAFFOLD — WP-EVM-01.** The contracts here are **stubs**: storage layout,
> events, NatSpec and signatures only. Every state-transition function
> reverts `NOT_IMPLEMENTED`. Real logic lands in later WPs (see plan below).
> This is the first code of the EVM port; "just an initial draft" per Rick.

## Arc Testnet target

USDC is Arc's native gas token, which collapses the dual-token (ETH gas vs
USDC premium) problem and is why the paymaster work package was dropped.
Verified network facts (design PR #201 §4.8.4, checked 2026-05-15):

| Item | Value |
|---|---|
| Chain id | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| WebSocket | `wss://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` (permissionless, USDC/EURC) |
| Testnet USDC | `0x3600000000000000000000000000000000000000` (6-decimal ERC-20 interface) |
| EVM | Prague hard fork (`evm_version = "prague"`) |

These constants are pinned in `src/ArcConfig.sol` and `.env.example`.

## Layout

```
src/
  ArcConfig.sol          Arc Testnet constants
  PactRegistry.sol       endpoint registry + protocol kill switch (stub)
  PactPool.sol           per-slug USDC coverage pools (stub)
  PactSettler.sol        settleBatch executor (stub)
  interfaces/            IPactRegistry / IPactPool / IPactSettler (design §3)
test/
  Deployment.t.sol       trivial compile/deploy sanity + Arc-constant pins
script/
  Deploy.s.sol           deploy placeholder (real deploy = WP-EVM-07)
foundry.toml             solc 0.8.30, evm_version = prague
.env.example             Arc Testnet env template (no secrets committed)
```

## Build & test

Requires [Foundry](https://book.getfoundry.sh/). No external Solidity
libraries — the scaffold is zero-dependency so it builds offline.

```bash
forge build
forge test
```

## What is done vs stubbed

**Done (WP-EVM-01):** Foundry project, Arc Testnet config + constants,
contract + interface skeletons matching design §3, zero-dep compile-sanity
test, env template.

**Stubbed (all reverts `NOT_IMPLEMENTED`):** every protocol mutation —
`registerEndpoint`, `updateEndpointConfig`, `pauseEndpoint`,
`pauseProtocol`, `updateFeeRecipients`, `topUp`, `balanceOf`, `settleBatch`.

## WP plan (next steps)

Design doc: **PR #201** — `docs/evm/2026-05-15-evm-expansion-design.md`
(§3 contract shapes, §4.8 Arc decisions, §8 WP list).

- **WP-EVM-02** — `PactRegistry` logic + OpenZeppelin access control
- **WP-EVM-03** — `PactPool` logic
- **WP-EVM-04/05** — `PactSettler` core + hardening (exposure cap, dedup)
- **WP-EVM-06** — full forge-std + fuzz test suite, gas snapshots, live
  USDC `decimals() == 6` assertion
- **WP-EVM-07** — deploy scripts + Arc Testnet deploy + arcscan verify

Paymaster work package: **dropped** (USDC-native gas, design §4.8.2).
