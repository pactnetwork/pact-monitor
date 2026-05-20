## `@q3labs/pact-sdk@0.1.0` — first public release

This is the first release of the Pact Network agent SDK. `createPact()` returns a `pact.fetch()` that you can use anywhere you'd use `fetch` — and on any **registered** API, covered calls route through the Pact Market proxy and the settler refunds breaches on-chain. Pact Network V1, mainnet, no oracle, no claim filing.

Published alongside `@q3labs/pact-protocol-v1-client@0.2.0` (first publish under the `@q3labs` scope — PDA derivers, account decoders, instruction builders, fee-recipient helpers).

### What you get

- `createPact({ network, signer })` — wires up the proxy transport, the durable observation buffer, the indexer poller, and the optional webhook receiver. ESM-only, Node ≥ 18, browser-via-bundler.
- `pact.fetch(url, init?)` — drop-in `fetch` replacement. Unregistered hosts degrade to a bare fetch and never break your call (the golden rule).
- `pact.setup({ allowanceUsdc })` — one-time global SPL approve to the SettlementAuthority delegate. That's the agent's entire on-chain footprint.
- `pact.topUp(usdc)` / `pact.revoke()` — re-approve / revoke the delegation.
- `pact.policy()` — on-chain insurable state (ATA balance, allowance, eligibility) + indexer aggregates.
- `pact.claims({ since?, limit? })` — settled refund records from the indexer.
- `pact.estimate(host)` — quote from the on-chain `EndpointConfig`.
- `pact.wrap(client)` — route a `ky`, `axios`, or `fetch` client through `pact.fetch`.
- Events: `failure`, `refund`, `billed`, `low-balance`, `degraded`.
- Optional webhook receiver (`config.webhook`) — latency-optimization over the poller, same idempotent sink, pinned ed25519 verification.

### One thing to know before you ship — B1 (devnet / localnet)

On mainnet the SDK works with no extra config. On devnet and localnet, on-chain ops (`setup`, `topUp`, `policy`) require an explicit `createPact({ programId })`. There is no devnet default. The devnet deploy is live for reads but its compiled `declare_id!` is the mainnet ID, so PDAs derived from `crate::ID` don't match the deploy address and `settle_batch` reverts `InvalidSeeds`. We will not ship a default that silently breaks settlement.

Covered proxy calls — the `pact.fetch()` path — do not need the program ID.

Full context in the README's *Operator notes* section.

### Install

```bash
npm install @q3labs/pact-sdk
```

### Quickstart

```ts
import { createPact } from "@q3labs/pact-sdk";
import { Keypair } from "@solana/web3.js";

const pact = await createPact({
  network: "mainnet",
  signer: Keypair.fromSecretKey(/* your 64-byte ed25519 secret */),
});

const res = await pact.fetch("https://api.helius.xyz/v0/addresses/…");
```

### Links

- README: <https://github.com/pactnetwork/pact-monitor/blob/main/packages/sdk/README.md>
- Changelog: <https://github.com/pactnetwork/pact-monitor/blob/main/CHANGELOG.md>
- Release PR: <https://github.com/pactnetwork/pact-monitor/pull/212>
- SDK PR (the headline change): <https://github.com/pactnetwork/pact-monitor/pull/210>

Help: <https://github.com/pactnetwork/pact-monitor/issues> · rick@quantum3labs.com · <https://t.me/metalboyrick>
