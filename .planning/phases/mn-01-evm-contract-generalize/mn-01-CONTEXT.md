# WP-MN-01 — Generalize EVM contracts — CONTEXT

- **Track:** Multi-Network refactor (MN), first WP
- **Branch:** `feat/multi-network-01-evm-contract-generalize` (off `feat/multi-network` off `feat/arc-protocol-v1`)
- **Captain:** Tu (in-harness)
- **Date opened:** 2026-05-20

## Purpose

Strip Arc-specific assumptions out of the Solidity codebase and its TypeScript client so any EVM chain configures via data (`chains.json`), not by forking the contract files. After WP-MN-01, adding a chain is a data edit, not a code edit.

This is P1 of the architecture spec — the necessary pre-work before the chain-abstraction layer (WP-MN-02) can wrap a multi-chain EVM client.

## Upstream artifacts (READ FIRST)

- `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §3 — WP-MN-01 deliverables, Gate A entry, Gate B exit (7-cat).
- `docs/evm/2026-05-19-multi-network-architecture-spec.md` §3 (L1 contracts layer) + §4 (package layout) + §11 (LOCKED decisions D1, D2).
- `docs/evm/2026-05-19-multi-network-READ-FIRST.md` — cover memo, acceptance criterion (Solana parity minus pay.sh), Anchor-legacy frozen rule.

## In scope

- Rename `packages/program-evm/protocol-evm-v1/src/ArcConfig.sol` → `ProtocolInvariants.sol`.
- Split chain-specific constants (chainId, USDC address) out into `packages/program-evm/protocol-evm-v1/config/chains.json`.
- Refactor `packages/program-evm/protocol-evm-v1/script/Deploy.s.sol` to read chain selection from `vm.envUint("CHAIN_ID")` + `chains.json`. Preserve the live USDC-decimals deploy guard (currently `IERC20Metadata(usdc).decimals() == EXPECTED_USDC_DECIMALS` at Deploy.s.sol:58–61).
- Update all Solidity test files that import `ArcConfig` to import `ProtocolInvariants` for invariants and read chain values from the new chains.json source (via Foundry's `vm.parseJsonAddress` or equivalent).
- Mirror chains.json into `packages/protocol-evm-v1-client/src/constants.ts` as the single TypeScript source of truth (or load from chains.json at build time — RESEARCH-decided).
- Add a drift test in `packages/protocol-evm-v1-client/test/chain-table-drift.test.ts` that fails if `constants.ts` and `chains.json` disagree.

## Out of scope

- Adding any non-Arc chain to chains.json (WP-MN-04 adds the second chain).
- The TypeScript `ChainAdapter` interface (WP-MN-02).
- Any service code (`settler`, `indexer`, `market-proxy`). They keep working unchanged.
- Mainnet deployment (Arc Testnet only; mainnet authority rotation is a separate concern).
- The legacy Anchor `pact-insurance` crate — frozen, do not touch (memory: `feedback_anchor_legacy`).

## Non-negotiables

1. **Deploy script behavior is preserved end-to-end.** The Arc Testnet deploy run must produce the exact same on-chain artifacts (chain id, USDC address, protocol parameters, treasury wiring, SETTLER_ROLE grants) as the pre-WP-MN-01 script did at PR #204 closeout. The only diff is HOW the script gets those values; the OUTCOME is byte-identical.
2. **USDC-decimals guard stays loud.** The require() check at Deploy.s.sol:58–61 fires before any contract is constructed if `IERC20Metadata(usdc).decimals() != EXPECTED_USDC_DECIMALS`. WP-MN-01 must keep this guard in its existing position, and must additionally guard that the configured `chains.json` `usdcDecimals` matches `ProtocolInvariants.EXPECTED_USDC_DECIMALS` (or whichever field RESEARCH lands on).
3. **No re-deploy of Arc Testnet.** Existing Arc Testnet deployment addresses in `protocol-evm-v1-client/src/addresses.ts` stay valid — WP-MN-01 is a refactor of how parameters are wired in source, not an on-chain change.
4. **Existing Foundry test count is preserved or grows.** The current Arc test suite (forge test) passes; WP-MN-01 adds the drift test in the client suite but does not remove any Foundry test.
5. **No edits to the legacy Anchor `pact-insurance` crate** (memory rule).

## Gate-A entry criteria (this CONTEXT + the RESEARCH doc satisfy them)

- Architecture spec §3 (L1) + §4 read by the implementer. Reference quotes in RESEARCH.
- RESEARCH lists every `ArcConfig` reference (grep audit, whole repo) and every hardcoded chain value in `protocol-evm-v1-client/` + the Solidity test suite. Done — see `mn-01-RESEARCH.md` §3.
- Captain VERDICT APPROVED — pending.

## Captain expectations of Gate-A verdict

Captain (Tu) reads `mn-01-RESEARCH.md`, confirms:
- The grep audit is exhaustive (no missing reference will surprise execution).
- The chains.json schema decision (RESEARCH §5.1) and `EXPECTED_USDC_DECIMALS` placement decision (RESEARCH §5.2) are sound.
- The drift-test strategy (RESEARCH §5.4) is feasible.
- The sub-task split into PLAN files (RESEARCH §6) is well-sized.

If APPROVED: captain writes `mn-01-CAPTAIN-GATE-A-VERDICT.md`, the implementer is unblocked to begin `mn-01-NN-PLAN.md` files. If REJECTED: captain enumerates what's missing; RESEARCH is revised.
