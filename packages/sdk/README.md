# @q3labs/pact-sdk

```bash
npm install @q3labs/pact-sdk
```

Unified Pact Network **agent** SDK. Replace `fetch` with `pact.fetch` and any
**registered** API call gets parametric refund coverage — automatically, on
Pact Network V1.

## Quickstart

Three steps from a fresh project to a covered call:

```ts
// 1. install: npm install @q3labs/pact-sdk
// 2. create:
import { createPact } from "@q3labs/pact-sdk";
import { Keypair } from "@solana/web3.js";

const pact = await createPact({
  network: "mainnet",
  signer: Keypair.fromSecretKey(/* your 64-byte ed25519 secret */),
});

// 3. call (drop-in fetch):
const res = await pact.fetch("https://api.helius.xyz/v0/addresses/…");
```

On mainnet that's the whole thing — the SDK ships a sane default for every
host, proxy, indexer, and program ID. The full example below adds the
one-time on-chain `setup()` (a single SPL approve) and event listeners.

## Supported runtimes

Node ≥ 18 (the package targets the Node 18+ `fetch`, `TextEncoder`, and
`WebCrypto` globals). Browser via any ESM bundler — Vite, Webpack 5, esbuild,
Rollup. The package is **ESM-only**; there is no CJS export.

## Full example

```ts
import { createPact } from "@q3labs/pact-sdk";
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

## Environment variables

The SDK doesn't read `process.env` directly — every knob is an explicit
`createPact()` field — but most operators want to feed those fields from env
vars, and we follow the convention below so the landing-page docs, the CLI,
and the SDK all agree. None of these are required on mainnet.

| Env var | Maps to | Default | When you need it |
|---|---|---|---|
| `SOLANA_RPC_URL` | `createPact({ rpcUrl })` | mainnet-beta / `api.devnet.solana.com` / `127.0.0.1:8899` | You're rate-limited on the public RPC, or you're on a private cluster. |
| `PACT_PROXY_BASE_URL` | `createPact({ proxyBaseUrl })` | `https://market.pactnetwork.io` (mainnet & devnet) | You're running your own Pact Market proxy, or pointing at a Railway preview. |
| `PACT_INDEXER_BASE_URL` | `createPact({ indexerBaseUrl })` | `https://indexer.pactnetwork.io` (mainnet & devnet) | Same as above for the indexer (refund/billed event source — best-effort). |
| `PACT_PROGRAM_ID` | `createPact({ programId })` | mainnet only; `null` on devnet/localnet (see B1 below) | Devnet, localnet, or any time you're pinning a specific deploy. |

The webhook receiver takes a **pinned ed25519 public key**, not a shared
secret. Pass it as `createPact({ webhook: { indexerSigningKey: "<bs58 pubkey>" } })`
— typically loaded from a `PACT_INDEXER_SIGNING_KEY` env var on your side.
Reusing the name `PACT_WEBHOOK_SECRET` is fine if you prefer it, but the
value is a public key, not a secret.

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
| `pact.stats()` | Local buffer aggregate (sync). Lamport totals are `bigint` — `JSON.stringify` will throw `TypeError: Do not know how to serialize a BigInt` unless you pass a replacer. |
| `pact.on(event, cb)` | `failure` `refund` `billed` `low-balance` `degraded`. |
| `pact.shutdown()` | Optional hard flush (CLIs/serverless/tests). |

Durability: every covered call is appended to a local JSONL buffer
(`~/.pact/sdk-observations.jsonl`) **before** any network I/O, so a hard kill
never loses an observation — the next `createPact()` resumes reconciliation.

## Operator notes (blockers)

- **B1 — devnet/localnet program ID.** `@q3labs/pact-protocol-v1-client`
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

## For coding agents

If you're a coding agent (Claude Code, Cursor, etc.) being asked to integrate
Pact into an agent project, follow
[`packages/sdk/skills/pact-sdk/SKILL.md`](./skills/pact-sdk/SKILL.md). It tells
you exactly what to install, what code to change, and what not to do — same
voice and shape as the `pact-pay` CLI skill.

## Build & test

```bash
pnpm --filter @q3labs/pact-sdk build
pnpm --filter @q3labs/pact-sdk test
pnpm --filter @q3labs/pact-sdk typecheck
```
