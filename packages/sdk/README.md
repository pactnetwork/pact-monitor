# @pact-network/sdk

Unified Pact Network **agent** SDK. Replace `fetch` with `pact.fetch` and any
**registered** API call gets parametric refund coverage — automatically, on
Pact Network V1.

```ts
import { createPact } from "@pact-network/sdk";
import { Keypair } from "@solana/web3.js";

const pact = await createPact({
  network: "mainnet",            // "mainnet" | "devnet" | "localnet"
  signer: agentKeypair,          // Keypair (server agents) | wallet adapter
});

// One-time: a single global SPL approve to the SettlementAuthority delegate.
await pact.setup({ allowanceUsdc: 5 });

// Drop-in fetch. Covered calls route through the Pact Market proxy; the
// settler auto-refunds on a covered breach. Unregistered hosts fall back
// to a bare fetch (never breaks your call).
const res = await pact.fetch("https://api.helius.xyz/v0/addresses/…");

pact.on("failure", (e) => {/* covered call classified non-ok */});
pact.on("refund",  (e) => {/* USDC settled back on-chain */});
pact.on("billed",  (e) => {/* premium settled on-chain */});
pact.on("degraded",(e) => {/* fell back to bare fetch */});
```

## How V1 actually works (this differs from the original design draft)

The design draft described a V2/oracle "claims" model. The **shipped V1
program** (`5bCJ…3xwc`) does not work that way, and this SDK targets the
shipped reality:

- **No oracle, no claims, no Policy PDA, no `enable_insurance`.** The agent's
  entire on-chain footprint is **one global SPL `approve`** to the singleton
  SettlementAuthority PDA (`pact.setup()`), which covers *every* endpoint.
  `pact.topUp(usdc)` is just a re-approve; `pact.revoke()` ends it.
- **Refunds are automatic and settler-driven.** A covered call is routed
  through the Pact Market proxy → classified → queued → the settler submits
  `SettleBatch` on-chain, which refunds breaches atomically. The agent never
  files anything.
- **Coverage is observed, not requested.** `refund`/`billed` events and
  `pact.claims()` come from polling the indexer for settled calls. The refund
  happens on-chain regardless of whether the SDK observes it.
- **Premium/refund are endpoint-fixed.** They come from the on-chain
  `EndpointConfig` (`pact.estimate(host)`). The per-call `insure` option and
  x402-declared value are **informational only** on proxy-routed V1 calls.
- **Coverage requires a registered endpoint.** V1 has no agent-side
  provisioning. An unregistered hostname degrades to a bare fetch and emits
  `degraded` — your call still succeeds.

## The golden rule

`pact.fetch()` behaves like `fetch()`. Any Pact-internal problem
(unregistered/paused host, unreachable or failed proxy, missing signing key,
unsignable body) silently falls back to a bare fetch of the original URL and
emits `degraded`. An upstream 4xx/5xx that the proxy *did* process is a
covered, insured outcome and is returned unchanged. Only the explicit ops
(`setup`/`topUp`/`revoke`/`policy`/`claims`/`estimate`) and `createPact()`
config validation throw.

## API

| Method | Notes |
|---|---|
| `pact.fetch(url, init?, opts?)` | Drop-in fetch. `opts.hostnameOverride` for shared gateways. |
| `pact.wrap(client)` | Route a `ky` instance, `axios` instance, or a `fetch` function through `pact.fetch`. |
| `pact.setup({allowanceUsdc?})` | Idempotent ATA-create + global approve. |
| `pact.topUp(usdc)` / `pact.revoke()` | Re-approve / revoke the delegation. |
| `pact.policy()` | Agent insurable state (ATA balance, allowance, eligibility) + indexer aggregates. |
| `pact.claims({since?,limit?})` | Settled refund records (from the indexer). |
| `pact.estimate(host)` | Quote from the on-chain `EndpointConfig`. |
| `pact.stats()` | Local buffer aggregate (sync). |
| `pact.on(event, cb)` | `failure` `refund` `billed` `low-balance` `degraded`. |
| `pact.shutdown()` | Optional hard flush (CLIs/serverless/tests). |

Durability: every covered call is appended to a local JSONL buffer
(`~/.pact/sdk-observations.jsonl`) **before** any network I/O, so a hard kill
never loses an observation — the next `createPact()` resumes reconciliation.

## Operator notes (blockers)

- **B1 — devnet/localnet program ID.** `@pact-network/protocol-v1-client`
  ships a program ID for **mainnet only** and marks every prior devnet deploy
  ORPHAN. On devnet/localnet you **must** pass a confirmed
  `createPact({ programId })`; on-chain ops (`setup`/`topUp`/`policy`) throw a
  clear error otherwise rather than delegating to the wrong PDA. Covered
  proxy calls do not need it.
- **B2 — indexer host.** Indexer polling is best-effort: if the public
  indexer host differs from the default, pass `indexerBaseUrl`. Refunds still
  settle on-chain regardless; only the `refund`/`billed` events depend on it.
- **Proxy auth (verified).** Covered requests are signed exactly as
  `@q3labs/pact-cli` signs them: bs58 ed25519 over
  `v1\n{METHOD}\n{path}\n{ts}\n{nonce}\n{sha256hex(body)|""}`, with
  `x-pact-project` mandatory. There is **no API key**; `apiKey` is reserved.

## Build & test

```bash
pnpm --filter @pact-network/sdk build
pnpm --filter @pact-network/sdk test
pnpm --filter @pact-network/sdk typecheck
```
