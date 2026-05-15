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

**Status:** 🟡 partial pass (2026-05-15) — discovery path validated; inference call blocked on funding

### What worked

| Step | Result |
|---|---|
| `createZGComputeNetworkBroker(wallet)` | ✅ created |
| Chain detection | ✅ logged Galileo testnet (16602) |
| `broker.inference.listService()` | ✅ returned 2 services, 1 chatbot |
| `broker.inference.getServiceMetadata(provider)` | ✅ returned `{ endpoint, model }` |

### What's live on Galileo right now

| | |
|---|---|
| Provider address | `0xa48f01287233509FD694a22Bf840225062E67836` |
| Model | `qwen/qwen-2.5-7b-instruct` |
| Endpoint | `https://compute-network-6.integratenetwork.work/v1/proxy` |
| Ledger contract | `0xa79F4c8311FF93C06b8CfB403690cc987c93F91E` (`getAccount(user, provider)`) |

### What blocked

- `broker.ledger.depositFund(N)` — **the on-chain contract requires `N >= 3 0G`**, enforced as a revert. Verbatim SDK error: `"No ledger exists yet. depositFund will create one, but the contract requires a minimum of 3 0G. Got 0.3 0G."` So 3 0G is a hard floor, not a soft suggestion.
- `broker.inference.getRequestHeaders(provider)` — auto-funds **2 0G** to the provider sub-account if it doesn't exist. Fails with `AccountNotExists(user, provider)` reverting `getAccount(...)` on the ledger contract.
- **Minimum to reach the inference POST: ~5 0G total** (3 main ledger + 2 sub-account). Plus ~1 0G locked balance and tx gas → comfortable budget ~6–7 0G.

### Surface drift from Day-0 research

1. **SDK's ESM build is broken.** `lib.esm/index.mjs` re-exports symbols that don't exist in `index-e9d81ce6.js` — Node throws `SyntaxError: does not provide an export named 'C'`. The CommonJS build at `lib.commonjs/` works fine. **Plan implication:** `zerog-compute-client` must be a CJS package, OR pin a future SDK version that fixes the ESM build, OR import from the explicit CJS path. The spike's `package.json` is `"type": "commonjs"` after the fix.
2. **Auto-funding amount of 2 0G** during `getRequestHeaders` is undocumented. The settler's lifecycle code must either: (a) pre-create per-provider sub-accounts via explicit `broker.ledger.transferFund(provider, 'inference', amount)` before any inference call, or (b) eat the 2 0G auto-fund on first contact and treat that as the per-provider provisioning cost.
3. **`getRequestHeaders` is on-chain** (it makes a `getAccount` call) — not just a header generator. Settler should cache headers per-provider per-window if possible.

### Plan implications

- `zerog-compute-client.connect()` must call `broker.ledger.depositFund(3)` once on cold start; treat the 3 0G as a sunk per-process cost.
- `zerog-compute-client.prepareProvider(addr)` should pre-fund the sub-account explicitly, not rely on auto-fund magic on first `getRequestHeaders`.
- Track `0xa48f01287233509FD694a22Bf840225062E67836` / qwen-2.5-7b-instruct as the demo's default model. If it stays up to Day 19, use it.

### Action items
- [ ] User: drip [faucet.0g.ai](https://faucet.0g.ai) ~10 more times to reach ~5–6 0G total. Then re-run the spike to complete validation through the inference POST + `processResponse` TEE verify.

## Spike 4 — ERC-7857

**Status:** ✅ done (research-only — see [`inft-erc7857/README.md`](inft-erc7857/README.md))
