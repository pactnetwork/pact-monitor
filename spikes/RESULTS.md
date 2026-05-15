# Pact-0G spike results

Living document — append as each spike runs. Updates feed back into the plan.

## Wallet

- Address: `0x99104B12E686E2dbC5f823f9C2DC56B0A0D71703`
- Network: Galileo testnet (chain 16602)

## Spike 3 — Storage SDK round-trip

**Status:** ✅ PASS (2026-05-15)

**Tx:** [`0xbe25530bd2b58b112f33757bb1548e40ee50234eae90700bb540bb19bf3cc011`](https://chainscan-galileo.0g.ai/tx/0xbe25530bd2b58b112f33757bb1548e40ee50234eae90700bb540bb19bf3cc011)
**Root hash:** `0x0b7b7ade62ec52639be479b048548547f6c54b1119fbb472168d766e710a9865`

| Metric | Value |
|---|---|
| Blob bytes | 334 |
| Upload time | 14.5 s |
| Download time | 1.5 s |
| Storage flow fee | ~61.5 µ0G |
| Total tx cost (gas + fee) | ~0.0011 0G |
| Storage nodes serving | 4 found, 2 selected |
| Determinism check | passed (same blob → same rootHash across two `merkleTree()` calls) |

### Surface drift from docs / Day-0 research

1. `indexer.upload(memData, RPC_URL, signer)` returns `{ txHash, rootHash, txSeq }` — there's a third field `txSeq` (a numeric `110766` for this upload) that the docs and Day-0 research did not mention. Record this in `zerog-storage-client`'s typed wrapper.
2. Upload latency is dominated by **storage-node sync wait**, not the on-chain tx. Saw `Waiting for storage node to sync (height=…)` looping for ~5 of the 14.5s. Settler must queue these writes, not block per call. Plan already says writes happen before `settleBatch` — confirm that batching N writes is feasible inside the settler's existing flush window.
3. The mainnet indexer URL `https://indexer-storage-turbo.0g.ai` is unverified in this spike (testnet-only). Re-run before Day 18 mainnet.

### Plan implications

- `zerog-storage-client.writeEvidence()` should return the full `{ txHash, rootHash, txSeq }` shape, not just `(cid, hash)`.
- Settler's evidence-write step is ~15s per blob with no batching. For demo throughput, queue blob writes asynchronously; the `settleBatch` tx can fire once N rootHashes are ready.
- Storage cost is negligible at hackathon scale (<<$1 even for thousands of calls).

## Spike 1 — Foundry bootstrap

**Status:** ✅ PASS deploy / ⚠️ verify path unresolved (2026-05-15)

**Contract:** [`0x0b7a1bBD829f402F4FA2d7F758F19e96112ce254`](https://chainscan-galileo.0g.ai/address/0x0b7a1bBD829f402F4FA2d7F758F19e96112ce254)

| Metric | Value |
|---|---|
| Network | Galileo testnet (chain 16602) |
| Solc | 0.8.24 |
| EVM version | `cancun` (no warnings, no runtime opcode reverts) |
| Total gas used | 414493 |
| Gas price | 3 gwei |
| Deploy cost | 0.001244 0G |
| `message()` returns | `"hello 0g"` ✓ |
| `deployer()` returns | `0x99104B12E686E2dbC5f823f9C2DC56B0A0D71703` ✓ |

### Plan implications

- ✅ `evm_version = "cancun"` works on 0G; no fallback needed.
- ✅ Foundry's broadcast path against `https://evmrpc-testnet.0g.ai` works without quirks.
- ⚠️ **`forge verify-contract` is broken against `chainscan-galileo.0g.ai/api`.** The explorer's `/api` endpoint serves the React SPA HTML, not a verification JSON API. Tried both default Etherscan-mode and `--verifier blockscout`. The error log spam in the deploy output is from forge's auto-verify trying the same path on the broadcast step.
- Verify is a **Day-18 submission requirement** for the mainnet `PactCore`/`EndpointINFT`/`MockUsdc` deploys. Resolve before then: try a `sourcify` verifier, look for a dedicated `verify.0g.ai` host, ask in 0G Discord, or check whether `chainscan.0g.ai` (mainnet) exposes the API at a different path than the testnet variant.
- Fix candidate: `forge verify-contract --verifier sourcify` (Sourcify takes any chain id and stores verified source publicly). Won't appear on chainscan as "Verified" but satisfies the spirit of the requirement.

### Action items
- [ ] Add a Week-1 ticket: resolve forge verify against 0G explorers (testnet + mainnet variants).

## Spike 2 — Compute broker

**Status:** pending (needs ≥3 0G testnet balance; currently 0.5 0G — drip faucet ~6× more)

## Spike 4 — ERC-7857

**Status:** ✅ done (research-only — see [`inft-erc7857/README.md`](inft-erc7857/README.md))
