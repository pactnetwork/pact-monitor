# @pact-network/protocol-zerog-client

TypeScript client for Pact-0G. Mirrors the shape of `@pact-network/protocol-v1-client` (Solana) but bound to the Solidity `PactCore` + `EndpointINFT` contracts on 0G Chain.

## Status

🚧 **Stubs only.** Type surface is final per the plan; method bodies throw
`not implemented`. Real implementation lands once `protocol-zerog-contracts` exports a stable ABI (Week 1).

## Surface

- `slugBytes(s)`, `normalizeSlug(s)`, `slugBytes16(s)`, `slugToString(b)` — pure ✅ ready
- `validateFeeRecipients(arr)` — pure ✅ ready (mirrors the contract's pre-flight checks)
- `decodeCallSettled(log)` — ⏳ needs ABI
- `PactCoreClient` (ethers wrapper) — ⏳ needs ABI

## Notes

- 16-byte `slug` and 16-byte `callId` match v1's Pinocchio sentinels — same encoding rules.
- BPS validation is chain-agnostic and copied from the v1 client's helpers.
- `EndpointINFT` helpers (mint, tokenURI parsing) live in a follow-up module once that contract is forked.
- The settler may also need a `prepareProvider(addr)` helper that lives in `@pact-network/zerog-compute-client`, not here — see spike 2's auto-funding finding in [spikes/RESULTS.md](../../spikes/RESULTS.md).
