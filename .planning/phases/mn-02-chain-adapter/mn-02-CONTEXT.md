# WP-MN-02 — ChainAdapter interface + SolanaAdapter — CONTEXT

- **Track:** Multi-Network refactor (MN), second WP
- **Branch:** `feat/multi-network-02-chain-adapter` (off `feat/multi-network@5a35c02` after WP-MN-01 merge)
- **Captain:** Tu (out-of-office); captain-proxy continues per directive
- **Date opened:** 2026-05-20

## Purpose

Introduce **one chain-touch seam** so all service code (`settler`, `indexer`, `market-proxy`, and Ken's SDK in WP-MN-05) can swap between Solana and EVM via a single interface — without leaking VM-specific imports through the codebase.

This WP defines the interface and lands its first implementation (`SolanaAdapter`) as a **pure passthrough** over `@pact-network/protocol-v1-client` + `@pact-network/wrap`. **No service swap happens here** — that's WP-MN-03b. The adapter exists as a sidecar; nothing imports it yet except the parity test that proves byte-identical behavior against the underlying client.

## Upstream artifacts (READ FIRST)

- `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §4 — WP-MN-02 deliverables, Gate A entry, Gate B exit (7-cat).
- `docs/evm/2026-05-19-multi-network-architecture-spec.md` §3 (L2 ChainAdapter layer) + §11 D1, D2, D5 (LOCKED).
- `docs/evm/2026-05-19-multi-network-offchain-services-spec.md` §5 — REV1 reframing of the per-call PUSH model (`watch(fromBlockOrSlot)` removed; `readEndpointConfigs()` + optional `tailSettlementEvents()` is the correct seam).

## In scope

- Define `ChainAdapter` interface in `packages/shared/src/chain-adapter.ts` per arch §3 L2 + REV1 corrections.
- Define supporting types: `ChainDescriptor`, `EndpointConfigSnapshot`, `SettleBatchInput`, `SettleBatchResult`, `EligibilityCheckResult`.
- Define `chains.ts` registry helpers (`getChain(name)`, `listChains()`) in `packages/shared/src/chains.ts` — D2-locked owner of the network registry. Sources from `packages/program-evm/protocol-evm-v1/config/chains.json` plus a hand-coded Solana entry.
- Implement `SolanaAdapter` in `packages/shared/src/adapters/solana/` — passthrough wrapper over `@pact-network/protocol-v1-client` (for endpoint configs, settle-batch building, PDA derivation) and `@pact-network/wrap` (for eligibility checks).
- Wire `@pact-network/shared` to depend on `@pact-network/protocol-v1-client` and `@pact-network/wrap`.
- Add parity tests proving `SolanaAdapter` outputs byte-identical results to direct client calls for every method, using recorded fixtures (offline).
- Add interface-shape contract test that any `ChainAdapter` implementer must pass — WP-MN-04's `EvmAdapter` re-runs the same test.

## Out of scope

- Editing any service file (`settler`, `indexer`, `market-proxy`, `wrap`, `sdk`). They keep working unchanged. WP-MN-03b swaps them.
- Adding the `+network` field to `SettlementEvent` — that's WP-MN-03a.
- The EvmAdapter — WP-MN-04.
- The Solana entry in `chains.json` — we add a Solana entry to the registry helpers in TS, but the Foundry-side `config/chains.json` stays EVM-only (Solana entry sources from TS constants directly, see RESEARCH §5.4).
- The Anchor legacy crate — frozen, do not touch.

## Non-negotiables

1. **Service code untouched.** `settler/src/submitter/submitter.service.ts`, `indexer/src/sync/on-chain-sync.service.ts`, `market-proxy/src/lib/balance.ts`, and all SDK code: zero edits. WP-MN-02 is purely additive in `@pact-network/shared`.
2. **Byte-identical proof for SolanaAdapter.** Every adapter method has a parity test that diff-zeroes against the equivalent direct client call.
3. **No `watch()` symmetric seam.** Per REV1 (arch §3 L2), the per-call ingestion stays PUSH — adapter has `readEndpointConfigs()` for the 5-min refresh and an OPTIONAL `tailSettlementEvents?()` for chains without a settler-side push. SolanaAdapter does NOT implement `tailSettlementEvents` (PUSH model is the production path).
4. **No legacy Anchor edits.**
5. **No remote pushes during captain-proxy execution.**

## Gate-A entry criteria

Satisfied by this CONTEXT + the companion `mn-02-RESEARCH.md`:

- Architecture spec §3 (L2) + §11 D2 read.
- RESEARCH enumerates every public method of `@pact-network/protocol-v1-client` used by `settler`, `indexer`, `market-proxy`; maps each to the proposed ChainAdapter method (or marks out-of-scope).
- RESEARCH locks the adapter location, interface shape, dep direction, and test-fixture strategy.
- Captain VERDICT APPROVED — pending.

## Captain expectations of Gate-A verdict

Captain (or captain-proxy) reads `mn-02-RESEARCH.md` and confirms:
- The mapping of every service-side client call to an adapter method is complete (no surprises in WP-MN-03b when services swap).
- The interface shape is forward-compatible with EvmAdapter (WP-MN-04 will not need to reshape the interface).
- The dep direction (`@pact-network/shared` depends on `@pact-network/protocol-v1-client` + `@pact-network/wrap`) does not create cycles.
- The parity-test strategy is feasible offline (no live RPC required at test time).

If APPROVED: captain writes `mn-02-CAPTAIN-GATE-A-VERDICT.md`, implementer unblocked to author PLAN files via `superpowers:writing-plans`. If REJECTED: gaps enumerated, RESEARCH revised.
