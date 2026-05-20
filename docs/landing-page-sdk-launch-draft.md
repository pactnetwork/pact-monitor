> **Draft.** Port these blocks into `metalboyrick/pact-network-landing` once `publish-sdk.yaml` has gone green for the first time and `@q3labs/pact-sdk@0.1.0` resolves on the npm registry. Do not edit the landing-page repo before then.

## Install

```bash
npm install @q3labs/pact-sdk
```

The package is ESM-only. Node ≥ 18, or a browser bundled by Vite, Webpack 5, esbuild, or Rollup. There is no CJS build.

> **Devnet / localnet (B1).** On mainnet the SDK works with no extra config. On devnet and localnet, on-chain ops (`setup`, `topUp`, `policy`) require you to pass `createPact({ programId })` explicitly — there is no default. The devnet deploy is live for reads but its `declare_id!` mismatches its address, so `settle_batch` reverts without the right program ID. See *Operator notes — B1* in the SDK README. This is at the install step, not buried in a footnote, because it is the single thing most likely to bite you.

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

That's the whole thing on mainnet. The SDK ships a default for every host, proxy, indexer, and program ID. Add `await pact.setup({ allowanceUsdc: 5 })` once per agent if you want on-chain coverage active (one SPL approve to the SettlementAuthority delegate).

## Supported runtimes

Node ≥ 18 — relies on the built-in `fetch`, `TextEncoder`, and `WebCrypto` globals.
Browser — works under any ESM bundler (Vite, Webpack 5, esbuild, Rollup).
ESM-only — no CJS export.

## Environment variables for live E2E

The SDK doesn't read `process.env` directly; every knob is an explicit `createPact()` field. The names below are the convention we use across the CLI, the dashboard, and our deploy templates, so you can pipe one set of env vars through to all of them.

| Env var | Maps to | Default | When you need it |
|---|---|---|---|
| `SOLANA_RPC_URL` | `createPact({ rpcUrl })` | Public mainnet-beta / devnet RPC, or `127.0.0.1:8899` for localnet | Public RPC rate limits, or you run a private cluster. |
| `PACT_PROXY_BASE_URL` | `createPact({ proxyBaseUrl })` | `https://market.pactnetwork.io` | You run your own Pact Market proxy, or are pointing at a Railway preview. |
| `PACT_INDEXER_BASE_URL` | `createPact({ indexerBaseUrl })` | `https://indexer.pactnetwork.io` | Same as above for the indexer (refund/billed event source — best-effort). |
| `PACT_PROGRAM_ID` | `createPact({ programId })` | mainnet only; **required** on devnet/localnet (B1) | Devnet, localnet, or any time you pin a specific deploy. |
| `PACT_INDEXER_SIGNING_KEY` | `createPact({ webhook: { indexerSigningKey } })` | None | You want the optional webhook receiver instead of polling the indexer. The value is a **bs58 ed25519 public key** (pinned), not a shared secret. |

## Where to get help

- GitHub issues: <https://github.com/pactnetwork/pact-monitor/issues>
- Email: rick@quantum3labs.com
- Telegram: <https://t.me/metalboyrick>
