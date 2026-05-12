---
name: market-quotes
description: >-
  Fetch live price quotes from the paid (x402) market-data API at
  https://dummy.pactnetwork.io/quote/<symbol>, called through Pact so every paid
  request gets a recorded coverage verdict and an automatic on-chain refund if
  the upstream breaches its SLA (a 5xx or a latency overrun). Use when the user
  asks for a price/quote from that endpoint, hands you a dummy.pactnetwork.io
  quote URL, or says "use dummy services", "I would like to use dummy services",
  "use the dummy", "demo Pact", "demo pact pay", "show me Pact coverage", "run
  the Pact demo", or "screen-record the Pact flow". Knows the two call paths
  (`pact pay` for x402, `pact <url>` for the insured gateway), how to behave
  naturally when the upstream fails, and — in a clearly-fenced operator section —
  the request parameters the presenter uses behind the scenes to choose the
  outcome.
---

# market-quotes — fetch paid price quotes through Pact (and stay covered)

`https://dummy.pactnetwork.io/quote/<symbol>` is a paid market-data API
(x402-priced) that returns a price quote for a ticker. Call it through Pact so
the request is covered: Pact wraps the paid call transparently — same result,
plus a recorded coverage verdict and a tiny per-call premium — and if the
upstream breaches its SLA *after you've already paid* (a 5xx, or a latency
overrun), Pact settles a refund back to you **on-chain**, automatically,
verifiable on Solscan. Treat it like any other paid API you'd reach for when a
task needs a quote.

Two call paths, both live on Solana mainnet:

| Path | Command | Settles via | Pool | Speed |
|---|---|---|---|---|
| **Gateway** — Pact is the HTTP client | `pact <url>` | `api.pactnetwork.io` → on-chain `settle_batch` | per-endpoint `dummy` pool (refund $0.01, premium $0.001) | ~40 s |
| **`pact pay`** — wraps `solana-foundation/pay` for x402 | `pact pay curl <url>` | `facilitator.pactnetwork.io` → on-chain `settle_batch` | shared `pay-default` pool (refund = the payment, premium $0.001) | settler batch cycle (a few min) |

> This endpoint is also what the Pact team uses to demo coverage end-to-end. If
> the user is recording or walking someone through the flow, the operator notes
> at the bottom of this file have the request parameters and beat sequence — but
> the agent-facing behavior is the same either way: just use the API.

## How to behave (read this first)

You're doing a real task that happens to need a paid quote. Act like it.

- **Treat `dummy.pactnetwork.io/quote/<symbol>` as the paid API you've been
  asked to call.** Call it the natural way — through `pact pay` (if it's an
  x402 endpoint, i.e. the URL has `?x402=1`) or `pact <url>` (the insured
  gateway). If you have the `pact-pay` skill, that routing is already its job;
  follow it.
- **Don't narrate the plumbing.** Don't announce query-string parameters,
  don't say "this is rigged to fail," don't explain that the upstream is a demo
  fixture. Just make the call. Whatever URL the presenter handed you, use it
  verbatim.
- **React to a failure the way you would for any flaky paid API.** If the call
  comes back `503` or times out: say so plainly — "the quote API returned a 5xx
  after I'd already paid" — note that the call was covered ("Pact flagged it as
  a covered breach; the refund is settling on-chain — `pact pay coverage <id>` /
  `pact calls show <id>`") and either retry or proceed. Calm and matter-of-fact,
  not theatrical.
- **Surface the receipt, not a lecture.** One line is enough: the premium, the
  verdict, and — once it's settled — the Solscan link. Let the tx speak.
- **If asked to do the whole thing as an agent task** ("get me an AAPL quote
  from this paid API and use it for X"), do exactly that: fetch via `pact pay` /
  `pact <url>`, then actually use the quote. The coverage behavior should look
  like a side-effect of doing the job, because it is.

## Calling the quote API

Prereqs (one-time): `npm i -g @q3labs/pact-cli` (0.2.6+) · for `pact pay`: the
`solana-foundation/pay` CLI + `pay setup` · `export PACT_MAINNET_ENABLED=1
PACT_RPC_URL=<mainnet rpc>` and, for `pact pay`, `PACT_FACILITATOR_URL=https://facilitator.pactnetwork.io`
· a demo wallet funded on mainnet (≥ ~0.5 USDC + ~0.01 SOL) with `pact approve 1.0`
done once. Full setup + the demo wallet on file: `docs/demo-market-runbook.md`.

### Gateway path — `pact <url>`

```bash
pact --json 'https://dummy.pactnetwork.io/quote/AAPL'        # → 200 quote; premium ~$0.001 debited, no refund
pact --json 'https://dummy.pactnetwork.io/quote/AAPL?fail=1' # → 503; premium debited, refund settling on-chain
pact calls show <call_id>                                    # → the settle_batch tx → https://solscan.io/tx/<sig>
# or let pact wait for the settlement itself:
pact --wait --json 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'
```

(Quote `?`-bearing URLs — in zsh an unquoted `?fail=1` is a glob.)

### `pact pay` path — wraps `pay` for x402

```bash
pact pay --json curl 'https://dummy.pactnetwork.io/quote/AAPL?x402=1'         # pay pays, 200 quote, coverage recorded, nothing to refund
pact pay --json curl 'https://dummy.pactnetwork.io/quote/AAPL?x402=1&fail=1'  # pay pays, then 503 → refund from pay-default
pact pay coverage <coverageId>                                                # → "settled" + the settle_batch Solscan link
```

Without `--json` the human lines land on stderr:
```
[pact] base 0.005 USDC + premium 0.001 USDC ... (covered by pay-default)
[pact] classifier: server_error  (status=503, reason=upstream 503)
[pact] policy: refund_on_server_error — refund 0.005 USDC (settling on-chain)
[pact] check status: pact pay coverage <coverageId>
```

The dummy's x402 `payTo` is the demo wallet itself, so on mainnet this is a
self-pay of $0.005 USDC — only the network fee is real money.

---

## OPERATOR / BACKSTAGE — not for the agent to recite on camera

This section is for the person running the demo. The agent should not read these
toggles out loud or pass them around as if they were part of the task — the
presenter decides the outcome by choosing which URL the agent is handed (or by a
tiny wrapper that appends the toggle), and it should look like the upstream just
happened to behave that way.

### Outcome toggles — `GET https://dummy.pactnetwork.io/quote/:symbol`

| query | effect |
|---|---|
| *(none)* | `200` `{"symbol":"AAPL","price":"287.90","currency":"USD","source":"pact-dummy-upstream","ts":<unix ms>}` |
| `?fail=1` | `503` `{"error":"upstream_unavailable",...}` — "agent paid, upstream 5xx'd → refund must trigger" |
| `?status=<100-599>` | respond with exactly that HTTP status |
| `?latency=<ms>` | sleep that many ms first (clamped 0–10000) — for a latency-SLA-breach (>2 s on the gateway) |
| `?body=<string>` | echo `<string>` verbatim as `text/plain` |
| `?x402=1` | the dummy acts as an x402 server: no payment header → `402` + an x402 challenge; retry *with* a payment header → treated as paid, then falls through to the branches above. So `?x402=1&fail=1` = "agent paid, then the upstream died." (Payment isn't verified — it's a demo target.) |

Toggles compose. Also: `GET /health` → `{"status":"ok",...}` (use it to warm the
Vercel cold start before filming), `GET /` → an HTML page listing all of this.

Bare probes, no `pact`/`pay` needed (for your own pre-flight, off camera):
```bash
curl -s  https://dummy.pactnetwork.io/health
curl -si 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'                                # 503
curl -si 'https://dummy.pactnetwork.io/quote/AAPL?x402=1'                                # 402 + challenge
curl -si -H 'X-Payment: x' 'https://dummy.pactnetwork.io/quote/AAPL?x402=1'              # 200 (paid)
curl -si -H 'Payment-Signature: x' 'https://dummy.pactnetwork.io/quote/AAPL?x402=1&fail=1'  # 503 (paid, then down)
```

### Suggested beat sequence for a recording

1. **Normal call.** Agent fetches a quote (`pact pay` or `pact <url>`, no
   toggle) and uses it for whatever the framing task is. Aside: "every paid call
   gets a Pact coverage verdict and a sub-cent premium — that's the cost of the
   guarantee."
2. **The upstream fails.** You hand the agent the same task but the URL now
   carries `?fail=1` (or `?latency=2500` on the gateway). The agent gets a 5xx /
   timeout *after paying*, says so, and notes Pact has it covered.
3. **The refund lands on-chain.** `pact pay coverage <id>` / `pact calls show
   <id>` → `settled` → open `https://solscan.io/tx/<sig>`. "The agent paid, the
   API failed, and without Pact that money's just gone. Here it is, back, on
   mainnet, no ticket filed." For `pact pay` the settle is on the settler's batch
   cycle — register a couple minutes before you film the check, or use a backup
   tx (below).
4. *(Optional)* **The agent does it unattended.** With the `pact-pay` skill
   installed, just ask in plain language — "get me the AAPL quote, it's a paid
   API" — and let it pick `pact pay` on its own.

### Current state (accurate as of 2026-05-12)

- `@q3labs/pact-cli@0.2.6` is on npm, multi-platform (macOS/Linux/Windows).
- **Gateway path**: `dummy` is onboarded as a Pact Market endpoint (`EndpointConfig`
  `CoEuw3mGqwwHxXkuQgeKNdkNGbUqeMkfeGRykPedjpvh`, `CoveragePool`
  `GAnhVQnVcPSp7zgaEsvPiY4peDpokmTqr2RXmTLSYtxx`, funded), `api.pactnetwork.io`
  serves the `dummy` handler. Verified mainnet settles (2026-05-12): breach
  `2eW69aYYE3UZ6EYCr147FgpwQu5zWLANMosqz8qyEuZDRtV8X9rCJ5yVzoyJpGUdcN4m1WsfJ6Gwbb6ZtEHHUYpK`,
  success `4XxvqT2R5mtxtSZDxT5iNbQuN9monopYSaRpM3L9HrTGGKj58qarPqoD7qNV96x4CA8Mh58dNL8njJ3W4a52mE5a`.
- **`pact pay` path**: `facilitator.pactnetwork.io` is deployed (Cloud Run + Cloud
  SQL + VPC egress), `pay-default` pool registered + funded. Verified mainnet
  settle (2026-05-12): coverage `cd6530c9-9320-4961-ab49-04cf20bcae35` → `settle_batch`
  `3WGRGWX5uDCMjB9TP1mimb4PA6hCrxaHXfrxB6jgKsupQNG5uEp2VL1UWH9EiUx7kZLdTwoH6KKXuNV3fNy5iuDL`.
- Deeper operator notes: `docs/demo-market-runbook.md`, `docs/premium-coverage-mvp.md`,
  `docs/facilitator-deploy.md`, `docs/dummy-upstream-deploy.md`.

### `--sandbox` (no mainnet, fake money)

`pact pay curl --sandbox '...?x402=1[&fail=1]'` runs `pay` on localnet with an
auto-funded fake wallet and no mainnet gate — useful for a dry run, but there's
no on-chain settlement, so the "here's the Solscan tx" beat needs the mainnet
path above.
