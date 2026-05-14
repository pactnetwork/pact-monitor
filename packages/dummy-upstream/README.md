# @pact-network/dummy-upstream

**Live:** https://dummy.pactnetwork.io — deployed on Vercel (project `dummy-upstream`, scope `metalboyricks-projects`).

A deliberately flaky HTTP "price quote" API — the demo/test target for **Pact
Network** premium coverage.

The whole point of this service is the query-string toggles on
`GET /quote/:symbol`. They let Pact's coverage flow be exercised
deterministically without depending on a real upstream provider being down:

- *agent paid → upstream 5xx'd → refund must trigger* → `?fail=1`
- *latency SLA breach* → `?latency=<ms>`
- *x402 paywall, so `pay` / `pact pay` attempts payment* → `?x402=1`
- *arbitrary status / body echoes for ad-hoc cases* → `?status=`, `?body=`

It's a tiny Hono service (`hono` + `@hono/node-server`), mirroring the
conventions in `packages/market-proxy/`. Has two modes for the `?x402=1`
toggle:

- **Emulation mode** (default, no env vars): emits a 402 challenge,
  accepts any `PAYMENT-SIGNATURE` header as "paid" without verification.
  For classifier-only testing — no real USDC moves. This is what runs
  when `DUMMY_X402_USE_PAYAI` is unset.
- **PayAI mode** (`DUMMY_X402_USE_PAYAI=1`): wires the x402 flow through
  [PayAI's hosted facilitator](https://facilitator.payai.network), so the
  retry's signed transaction is actually verified and settled on-chain.
  Funds land in `DUMMY_X402_PAY_TO` (default: the Pact `pay-default`
  coverage pool's USDC vault, `J55fpAi…`) — which means a refund-on-breach
  flow repays from the same vault the settlement just fed. Self-balancing.
  See [PayAI mode](#payai-mode) below.

## Routes

| Route | Response |
| --- | --- |
| `GET /health` | `200` `{"status":"ok","service":"pact-dummy-upstream"}` |
| `GET /quote/:symbol` | `200` JSON quote (toggles below). Default body: `{"symbol":"<SYMBOL upper>","price":"287.90","currency":"USD","source":"pact-dummy-upstream","ts":<unix ms>}` |
| `GET /` | a small static HTML page listing the toggles with example curls |

### `/quote/:symbol` toggles

| Query | Effect |
| --- | --- |
| *(none)* | `200` JSON price quote |
| `?fail=1` | `503` `{"error":"upstream_unavailable","symbol":...,"source":...,"ts":...}` — the "agent paid, upstream 5xx'd, refund must trigger" case |
| `?status=<3-digit>` | respond with that HTTP status code. Validated to `100–599`; ignored otherwise |
| `?latency=<ms>` | sleep that many ms before responding. Clamped to `0–10000`. Applied **first**, regardless of which response branch wins (so a latency-breach demo gets the delay even on a 503) |
| `?body=<string>` | return that string verbatim as `text/plain` with status `200`, instead of the JSON quote |
| `?x402=1` | `402 Payment Required` with an x402-style challenge (see below), so an x402-aware client (`pay`, `pact pay`) attempts payment |

Toggles **compose**, e.g. `?fail=1&latency=2000` sleeps ~2s then `503`s.
Precedence when several apply: `x402` → `status` → `fail` → `body` → default
quote. (`latency` is orthogonal — applied before any of them.)

### Example curls

```bash
curl -s  http://localhost:8080/health
curl -s  http://localhost:8080/quote/AAPL
curl -si http://localhost:8080/quote/AAPL?fail=1               # 503
curl -si http://localhost:8080/quote/AAPL?status=502           # 502
curl -s  http://localhost:8080/quote/AAPL?latency=1500         # ~1.5s delay
curl -s  'http://localhost:8080/quote/AAPL?body=hello'         # text/plain "hello"
curl -si http://localhost:8080/quote/AAPL?x402=1               # 402 + x402 challenge
curl -si 'http://localhost:8080/quote/AAPL?fail=1&latency=2000'  # composes
```

## x402 wire format

`pact-cli` does **not** parse x402 challenges itself — `pact pay` delegates to
[solana-foundation/pay](https://github.com/solana-foundation/pay), which speaks
the wire format. There is no x402 parser in this monorepo to mirror (the
`market-proxy` 402 path is Pact's own balance/allowance preflight, not an x402
challenge). So this service emits the **public x402 v1 challenge shape** — the
`accepts` array described at <https://x402.org> and used by the
`coinbase/x402` reference implementation:

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: x402 realm="pact-dummy-upstream"
PAYMENT-REQUIRED: <base64(JSON of accepts[0])>
Content-Type: application/json

{
  "x402Version": 1,
  "error": "payment_required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "solana",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "PactDemoUpstreamPayTo1111111111111111111111",
      "maxAmountRequired": "5000",
      "resource": "<the URL that was 402'd>",
      "description": "pact-dummy-upstream demo x402 paywall (no real funds move)",
      "mimeType": "application/json",
      "maxTimeoutSeconds": 60
    }
  ]
}
```

Notes:

- `maxAmountRequired` is in **atomic** units. `5000` / `1e6` = `0.005` USDC
  (USDC has 6 decimals).
- `asset` is the canonical Solana mainnet USDC mint; `payTo` is an arbitrary
  demo address. **No real funds move** — this server takes no payments; the
  402 just gives an x402-aware client something to react to.
- The `PAYMENT-REQUIRED` response header carries `base64(JSON.stringify(accepts[0]))`.
  The casing intentionally mirrors the `PAYMENT-RESPONSE` / `PAYMENT-RECEIPT`
  headers that `packages/monitor/src/payment-extractor.ts` looks for on the
  *response* side.
- `WWW-Authenticate: x402` is set so generic HTTP clients see a challenge
  scheme.

## PayAI mode

When `DUMMY_X402_USE_PAYAI=1` is set, the dummy promotes `?x402=1` from a
no-op stamp to a real x402 settle flow via PayAI's hosted facilitator.

### What changes

| Scenario | Emulation mode (default) | PayAI mode |
| --- | --- | --- |
| `?x402=1` no payment header | 402 with hand-built challenge | 402 with PayAI-built challenge (SDK-generated) |
| `?x402=1` with `PAYMENT-SIGNATURE` | accepted without checks | verified against PayAI; bad sig → 402 again |
| `?x402=1` (happy path) | "PAYMENT-RESPONSE: accepted; demo=1" stamp, 200 | verify → return 200 → settle on-chain to `DUMMY_X402_PAY_TO`. Real USDC moves. |
| `?x402=1&fail=1` (MODE C) | passes through to 503, no payment | verify → **settle first** (real USDC moves) → return 503. The "agent paid, got nothing" case Pact's refund insures. |
| `?x402=1&status=5xx` | passes through to the status, no payment | verify → settle first → return that status |

The MODE C settlement order is deliberate: Pact only refunds when a
payment leg actually happened. Settling before the failure reproduces
the real-world worst case (a merchant who eagerly settled then crashed)
which is exactly what Pact's coverage protects against. Net cost to the
agent in MODE C with `DUMMY_X402_PAY_TO = pay-default vault` is roughly
just Pact's premium: the 0.005 USDC the agent pays gets refunded from
the same vault the facilitator just credited.

### Env vars

| Var | Required | Default | What it does |
| --- | --- | --- | --- |
| `DUMMY_X402_USE_PAYAI` | yes | unset | Set to `1` to enable PayAI mode. Anything else = emulation. |
| `DUMMY_X402_PAY_TO` | yes | `J55fpAivCj6LTy4DEK6WaeoTxhB2hCrLRWtkoS774Gon` | Where settled USDC lands. Default = mainnet `pay-default` pool vault. **NOT a derived ATA** — this is a raw keypair pre-allocated when the endpoint was registered. Read it off `CoveragePool.usdcVault` from chain. |
| `DUMMY_X402_PAYAI_NETWORK` | no | `solana` | `solana` (mainnet) or `solana-devnet`. Mainnet pool vault won't accept devnet USDC; if you set this to devnet, override `DUMMY_X402_PAY_TO` to a devnet vault. |
| `DUMMY_X402_RPC_URL` | no | public mainnet/devnet | Solana RPC the SDK uses for verification + settlement. Public endpoints rate-limit aggressively for production traffic; use Helius / QuickNode if real volume. |
| `DUMMY_X402_FACILITATOR_URL` | no | `https://facilitator.payai.network` | PayAI facilitator. Swap to a local mock for tests. |
| `PAYAI_API_KEY_ID` | no | — | PayAI auth key ID. Without this the SDK uses the free tier. |
| `PAYAI_API_KEY_SECRET` | no | — | PayAI auth key secret (Ed25519 PKCS#8, raw base64 or `payai_sk_…`). Set both ID and secret to bypass free-tier rate limits. |

### Vercel setup (production)

In the dummy-upstream Vercel project's env vars:

```
DUMMY_X402_USE_PAYAI=1
DUMMY_X402_PAY_TO=J55fpAivCj6LTy4DEK6WaeoTxhB2hCrLRWtkoS774Gon
DUMMY_X402_PAYAI_NETWORK=solana
DUMMY_X402_RPC_URL=https://api.mainnet-beta.solana.com   # or Helius
PAYAI_API_KEY_ID=<your-payai-key-id>
PAYAI_API_KEY_SECRET=<your-payai-key-secret>
```

After deploy, hit `https://dummy.pactnetwork.io/quote/AAPL?x402=1` and
look for the startup log line: `[dummy-upstream] PayAI x402 enabled:
network=solana treasury=J55fpAi… …`. If you see this, PayAI mode is on.
If you see no such line, the env var isn't getting through and you're
still in emulation.

### Watching the pool vault on-chain

The pay-default pool vault is `J55fpAivCj6LTy4DEK6WaeoTxhB2hCrLRWtkoS774Gon`.
Open it on Solscan; every successful `pact pay curl …dummy.pactnetwork.io…?x402=1`
should produce an incoming USDC transfer of `0.005`. Every breach
(MODE C, i.e. `?fail=1` or `?status=5xx`) should produce that same
transfer IN, then a matching `settle_batch`-issued transfer OUT shortly
after as Pact's settler processes the refund. The net delta on the pool
over a balanced demo run is approximately zero, minus Pact's premium
(which the pool keeps).

## Local development

```bash
pnpm --filter @pact-network/dummy-upstream dev      # tsx watch, :8080
pnpm --filter @pact-network/dummy-upstream build    # tsc → dist/
pnpm --filter @pact-network/dummy-upstream start    # node dist/index.js
pnpm --filter @pact-network/dummy-upstream test     # vitest
pnpm --filter @pact-network/dummy-upstream typecheck
```

`docker run` still works too — the `Dockerfile` (build context = repo root,
mirrors `packages/market-proxy/Dockerfile`) builds the `@hono/node-server`
bootstrap (`src/index.ts`) and listens on `$PORT` (default `8080`). It's no
longer the deploy path (see below), just a convenience for running the stub in
a container locally.

## Deploy

Deployed to **Vercel** as a single Node serverless function, served at
`https://dummy.pactnetwork.io`. The Vercel project imports this monorepo with
**Root Directory = `packages/dummy-upstream`**; `api/index.ts` (the
`hono/vercel` adapter wrapping `createApp()`) is the function, and `vercel.json`
rewrites every path to it. No env vars / secrets.

- `api/index.ts` — Vercel Node serverless function (`hono/vercel`'s `handle()`).
- `vercel.json` — `framework: null`, `buildCommand: ""`, rewrite `/(.*)` → `/api/index`.
- `engines.node` (`package.json`) pins the function to Node 20.x.

Validate the Vercel build locally (no auth needed):

```bash
npx --yes vercel build      # → .vercel/output/ with functions/api/index.func
```

Full deploy + custom-domain + DNS runbook: `docs/dummy-upstream-deploy.md`.

> Originally slated for GCP Cloud Run (the same build/deploy GitHub Actions
> pattern as the other `pact-network` services) — that route was dropped in
> favour of Vercel for this small stateless demo stub. The Cloud Run wiring
> (`pact-dummy-upstream` `service_name` option in the workflows, `deploy/dummy-upstream/main.tf`)
> has been removed.
