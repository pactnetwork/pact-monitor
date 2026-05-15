# @pact-network/zerog-compute-client

CommonJS-only typed wrapper over [`@0gfoundation/0g-compute-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-compute-ts-sdk) (v0.8.3).

## Why CJS

This package compiles as `module: CommonJS` so the SDK's `require`-conditional
export resolves with the most build-stable toolchain path.

**ESM importers must use the Node-guaranteed default form:**

```ts
import zc from '@pact-network/zerog-compute-client';
const { ZerogComputeClient, GALILEO_TESTNET } = zc;
```

Node's CJS→ESM named-export *synthesis* (`import { X } from …`) is not
guaranteed across toolchains; only the default export (`module.exports`) is.
Use the default-import destructure above and the consumer stays portable.

## ensureLedger error handling

`ensureLedger()` swallows **only** the SDK's exact benign message
`Ledger already exists, with balance: …` (verified in
`@0gfoundation/0g-compute-ts-sdk@0.8.3` `lib.commonjs`). Every other
error — including the sub-minimum `No ledger exists yet … requires minimum
of 3 0G` and any RPC failure — propagates so callers fail loud.

## Ledger contract addresses

`networks.ts` `ledgerContract` is **informational only** — the broker is
constructed with no explicit ledger CA, so the SDK auto-detects per chain id.
The values are the SDK's own `CONTRACT_ADDRESSES.{testnet,mainnet}.ledger`
(the original scaffold value was the *inference serving* contract).

## Status

🟡 **Surface validated through discovery (listService, getServiceMetadata). Inference POST + `processResponse` not yet exercised** because it needs ≥5 0G testnet funding (3 ledger + 2 sub-account). Re-run [spikes/compute-broker](../../spikes/compute-broker/) once the wallet has enough.

## API

```ts
import zc from '@pact-network/zerog-compute-client';
const { ZerogComputeClient, GALILEO_TESTNET } = zc;

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
