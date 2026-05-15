# @pact-network/zerog-compute-client

CommonJS-only typed wrapper over [`@0gfoundation/0g-compute-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-compute-ts-sdk) (v0.8.3).

## Why CJS

The SDK's ESM build at v0.8.3 is broken — `lib.esm/index.mjs` re-exports symbols (`C`, `F`, `H`, …) that don't actually exist in the bundled chunk. Importing from an ESM consumer fails at module instantiation with `SyntaxError: does not provide an export named 'C'`. The CJS build at `lib.commonjs/` works correctly.

This package compiles as `module: CommonJS` so the SDK's `require`-conditional export is resolved. **Importers in ESM packages can still consume us** because Node's ESM-from-CJS interop handles named exports automatically.

Verified by spike 2 (2026-05-15). See [spikes/RESULTS.md](../../spikes/RESULTS.md).

## Status

🟡 **Surface validated through discovery (listService, getServiceMetadata). Inference POST + `processResponse` not yet exercised** because it needs ≥5 0G testnet funding (3 ledger + 2 sub-account). Re-run [spikes/compute-broker](../../spikes/compute-broker/) once the wallet has enough.

## API

```ts
import { ZerogComputeClient, GALILEO_TESTNET } from '@pact-network/zerog-compute-client';

const compute = new ZerogComputeClient(GALILEO_TESTNET, process.env.PRIVATE_KEY!);

// one-time setup
await compute.ensureLedger();                 // ≥3 0G enforced on-chain
const [first] = await compute.listChatbotServices();
await compute.prepareProvider(first.provider); // pre-create sub-account, avoids auto-fund magic

// per call
const { body, latencyMs, chatId, teeVerified } = await compute.callInference({
  provider: first.provider,
  messages: [{ role: 'user', content: 'hello' }],
  teeVerify: true,
});
```

## Known live providers (Galileo testnet, captured spike 2)

| Provider | Model | Endpoint |
|---|---|---|
| `0xa48f01287233509FD694a22Bf840225062E67836` | `qwen/qwen-2.5-7b-instruct` | `https://compute-network-6.integratenetwork.work/v1/proxy` |

Validate liveness before Day 19 demo shoot — providers can rotate.

## Funding model

- **Main ledger account**: created on first `depositFund(3)`. The 3 0G floor is **enforced on-chain** — sub-3 deposits revert.
- **Per-provider sub-account**: auto-funded 2 0G on first `getRequestHeaders` if not pre-created. Use `prepareProvider()` to control the amount and avoid surprise.
- **Per-call locked balance**: ~1 0G locked until `processResponse` settles it. Refunded on settle.
- **Cold-start minimum**: ~6 0G for first inference call. Plan for this in the settler's mainnet runbook.
