---
name: pact-sdk
description: >-
  Use when you're being asked to "integrate Pact", "add agent insurance", "add
  refund coverage for an agent that calls APIs", "wrap fetch with pact", or
  "make my agent's API calls insured / covered / refundable" — or any time
  you're editing an agent project that calls paid HTTP APIs (Helius, Birdeye,
  Jupiter, fal.run, Elfa, x402-gated endpoints, etc.) and want covered calls.
  Install `@q3labs/pact-sdk` (npm), construct a `pact` instance once with
  `createPact({ network: "mainnet", signer })`, then replace the agent's
  `fetch` with `pact.fetch`. Do NOT pass `programId` on mainnet (the default
  is correct); on devnet/localnet `programId` is REQUIRED. Do NOT gate the
  call on `pact.setup()` succeeding — `setup()` is a one-time on-chain SPL
  approve, run it once per install, never per request. Do NOT wrap unrelated
  fetches (free APIs, localhost, your own backend, static-CDN GETs) — Pact
  has nothing to cover there. Do NOT add try/catch around `pact.fetch` that
  re-throws on `degraded` — degraded means a bare fetch succeeded, the call
  is fine. Do NOT use this skill for the Monitor SDK
  (`@q3labs/pact-monitor`) — that's a separate, recording-only product.
---

# pact-sdk — integrate `@q3labs/pact-sdk` into an agent project

`@q3labs/pact-sdk` is the agent-side SDK for Pact Network. It's a drop-in
`fetch()` that routes calls to **registered** hosts through the Pact Market
proxy, gets a classified outcome (success / breach), and auto-refunds on
covered breaches via on-chain `settle_batch`. Unregistered hosts fall through
to a bare `fetch` — they never break.

This skill is for **editing source code** to add the SDK to a project. For
shell-level paid calls (`pay curl`, `pay http`), use the `pact-pay` skill
instead.

## Rule

**Add `import { createPact } from "@q3labs/pact-sdk"` once at agent boot,
construct the instance once with the agent's Solana signer, and replace
every paid-API `fetch(url, init)` with `pact.fetch(url, init)`.** That's the
whole change. Do not add it anywhere else.

## Install

```bash
npm install @q3labs/pact-sdk
# or
pnpm add @q3labs/pact-sdk
# or
yarn add @q3labs/pact-sdk
```

Requirements: Node ≥ 18, ESM project (`"type": "module"` in `package.json`
or `.mjs` files). The package is **ESM-only** — there is no CJS export.
`@solana/web3.js` is a direct runtime dependency, so `npm install` pulls it
in automatically; do not also add it unless the project already uses it.

## Integrate (the canonical diff)

Find the fetch the agent uses to hit paid APIs, then change it:

**Before:**

```ts
const res = await fetch(url, init);
```

**After:**

```ts
// once, at agent boot — NOT per request
import { createPact } from "@q3labs/pact-sdk";
import { Keypair } from "@solana/web3.js";

const pact = await createPact({
  network: "mainnet",
  signer: agentKeypair,
});

// then, anywhere the agent makes a paid HTTP call:
const res = await pact.fetch(url, init);
```

Notes:

- `createPact` is `async` — `await` it once and store the result. Do not
  call `createPact` per request; it spins up an indexer poller, lifecycle
  hooks, and a durable buffer on construction.
- Reuse the same `pact` instance across the entire process. If the project
  uses dependency injection, pass `pact` like you'd pass a logger.
- `pact.fetch` has the same signature as `fetch` (`(url, init?)` →
  `Promise<Response>`). Existing callers don't change.

## Where the signer comes from

Pick the case that matches the project:

- **Server agent with a managed `Keypair`** (most common):
  ```ts
  import { Keypair } from "@solana/web3.js";
  const agentKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.AGENT_SECRET_KEY_JSON!)),
  );
  // or from base58, or from a 64-byte ed25519 secret stored in your KMS
  ```
  The secret is the **64-byte** ed25519 secret (seed + pubkey), not the
  32-byte seed.

- **Browser agent with a wallet adapter**: pass the adapter directly as
  `signer`. The adapter must expose a `publicKey.toBase58()`. If the
  adapter can't expose the raw ed25519 secret for request signing, also
  pass `requestSigningSecretKey: <Uint8Array(64)>` (a session key whose
  trailing 32 bytes match `signer.publicKey`).

- **Quick prototyping**:
  ```ts
  const agentKeypair = Keypair.generate();
  ```
  Fine for trying the API — `pact.fetch` will route through the proxy and
  emit events — but the generated key has no USDC and no SPL approve, so
  it can't actually settle on-chain. Use a funded key for any real
  coverage flow.

## One-time on-chain setup

After constructing `pact`, run **once per agent install**:

```ts
await pact.setup({ allowanceUsdc: 5 });
```

This creates the agent's USDC ATA (if missing) and a single global SPL
`Approve` to Pact's SettlementAuthority delegate. That one approve covers
**every** endpoint — there is no per-endpoint provisioning in V1.

Operational rules for `setup()`:

- Idempotent. Safe to re-run; if the approve already matches, it's a no-op
  on-chain.
- Run it at install time (a setup script, a first-run flag, a migration),
  **not** at every agent boot, and **never** per request.
- It only succeeds with a funded signer (needs SOL for fees and a real
  on-chain address). On a generated `Keypair.generate()` it will throw.
- `pact.topUp(usdcAmount)` re-approves to a new allowance. `pact.revoke()`
  ends the delegation.

## B1 — devnet / localnet (required reading)

On **mainnet**, the SDK ships a working default program ID. Omit
`programId`.

On **devnet** and **localnet**, `createPact({ programId: "<base58 id>" })`
is **REQUIRED** for any on-chain op (`setup`, `topUp`, `policy`,
`estimate`). The protocol client deliberately has no devnet default
because the prior devnet deploy's `declare_id!` mismatched its on-chain
address — running without an explicit `programId` would derive wrong PDAs
and `settle_batch` would revert.

Covered proxy calls (`pact.fetch`) on devnet do **not** need `programId`
— but the moment you call `setup()` you need it, and without `setup()`
nothing is actually covered. So in practice: on devnet, always pass
`programId`. See the SDK README's *Operator notes — B1* section for the
historical context.

## The golden rule (do NOT break)

`pact.fetch` is **fall-through safe**. If anything Pact-internal fails —
the host isn't registered, the proxy is unreachable, the request can't be
signed, the response can't be parsed — the SDK silently performs a bare
`fetch(url, init)` of the original URL and emits a `degraded` event. The
caller gets a real `Response` back.

Do NOT do this:

```ts
// WRONG — defeats the golden rule
try {
  const res = await pact.fetch(url, init);
} catch (err) {
  // pact.fetch only throws for the same reasons fetch() throws (network
  // down, abort). Don't add re-throw logic on top of it.
  throw err;
}

// ALSO WRONG — gating the call on coverage
let degraded = false;
pact.on("degraded", () => { degraded = true; });
const res = await pact.fetch(url, init);
if (degraded) throw new Error("not covered");   // NO
```

If the agent legitimately needs to know a call was degraded (e.g. to log
it, or to skip an SLA assertion), listen for the `degraded` event and
record it out-of-band — don't gate the call's success on it.

```ts
pact.on("degraded", (e) => logger.warn({ url: e.url, reason: e.reason }, "pact degraded"));
pact.on("failure",  (e) => logger.warn(e, "covered call classified non-ok"));
pact.on("refund",   (e) => logger.info(e, "USDC refund settled on-chain"));
pact.on("billed",   (e) => logger.info(e, "premium settled on-chain"));
```

The explicit on-chain ops (`setup`, `topUp`, `revoke`, `policy`, `claims`,
`estimate`) and `createPact()` config validation **do** throw — those are
the only things to wrap in try/catch.

## What this skill is NOT for

- **Free APIs / localhost / the project's own backend** — Pact has nothing
  to cover. Leave those as plain `fetch`.
- **Pact CLI invocations** (`pact pay`, `pact <url>` against an onboarded
  provider) — that's the `pact-pay` skill's domain.
- **`@q3labs/pact-monitor`** — recording-only Monitor SDK, no on-chain
  refunds. Different product, different package. Don't conflate them.
- **Wrapping a fetch that's already proxied** — if the agent already
  routes a call through `pact <url>` (CLI gateway) or another Pact proxy,
  do not also wrap that fetch with `pact.fetch`. You'd double-route.
- **Static-CDN GETs, health checks, telemetry pings, internal RPC** —
  same as free APIs. No coverage to add.

## Gotcha — `pact.stats()` returns `bigint` counters

The `totalPremiumLamportsObserved` / `totalRefundLamportsObserved` fields on
`pact.stats()` are JavaScript `bigint`, not `number`. A naive
`JSON.stringify(pact.stats())` throws `TypeError: Do not know how to serialize
a BigInt`. If you need to serialize stats (e.g., to log or to ship to a
dashboard), pass a replacer:

```ts
const safe = JSON.stringify(pact.stats(), (_, v) =>
  typeof v === "bigint" ? v.toString() : v,
);
```

This is the only place the SDK leaks `bigint` into a consumer-facing return
value. Everything else is plain JSON-safe types.

## Verification

After integrating, run this one-liner from the project root:

```bash
node --input-type=module -e "import('@q3labs/pact-sdk').then(m => console.log(typeof m.createPact))"
# expect: function
```

If it prints `function`, the install resolved and the ESM export is
reachable. If it errors with `ERR_REQUIRE_ESM` or `Cannot find module`,
the project is not ESM-configured — fix `"type": "module"` in
`package.json` (or move the caller to an `.mjs` file) before continuing.

## Links

- npm: <https://www.npmjs.com/package/@q3labs/pact-sdk>
- GitHub release: <https://github.com/pactnetwork/pact-monitor/releases/tag/sdk-v0.1.0>
- SDK README: <https://github.com/pactnetwork/pact-monitor/blob/main/packages/sdk/README.md>
- Landing-page docs (Agent SDK overview): <https://pactnetwork.io/docs/agent-sdk/overview/>
