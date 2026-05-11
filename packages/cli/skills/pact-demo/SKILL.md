---
name: pact-demo
description: >-
  Use the Pact "dummy services" — a live, deliberately-flaky demo upstream at
  https://dummy.pactnetwork.io for exercising / demoing Pact Network premium
  coverage on paid API calls. Use when the user says "use dummy services", "I
  would like to use dummy services", "use the dummy", "pact dummy",
  "dummy.pactnetwork.io", "demo Pact", "show me Pact coverage", "demo pact pay",
  "show the pay.sh failure case", "show me what happens when a paid API fails",
  or asks to walk through / screen-record the Pact coverage flow. Knows the
  dummy's query-string toggles (?fail / ?status / ?latency / ?body / ?x402), the
  exact `pact pay` / `pact <url>` commands, and what to narrate at each step.
---

# pact-demo — demo Pact Network coverage with the flaky dummy upstream

`https://dummy.pactnetwork.io` is a deliberately-flaky "price quote" API built
to demo Pact coverage. You drive it with query-string toggles, then call it
through `pact pay` (wrapping pay.sh) or `pact <url>` (the insured gateway) and
show that Pact records / refunds when the upstream misbehaves.

## The dummy's toggles — `GET https://dummy.pactnetwork.io/quote/:symbol`

| query | effect |
|---|---|
| *(none)* | `200` `{"symbol":"AAPL","price":"287.90","currency":"USD","source":"pact-dummy-upstream","ts":<unix ms>}` |
| `?fail=1` | `503` `{"error":"upstream_unavailable",...}` — the "agent paid, upstream 5xx'd, refund must trigger" case |
| `?status=<100-599>` | respond with that HTTP status |
| `?latency=<ms>` | sleep that many ms first (clamped 0–10000) — for latency-SLA-breach demos |
| `?body=<string>` | echo that string verbatim as `text/plain` |
| `?x402=1` | acts as a **demo x402 server**: a request *without* a payment header → `402` + an x402 challenge (`accepts` array + `PAYMENT-REQUIRED` header); the retry *with* a payment header (`X-PAYMENT` / `PAYMENT-SIGNATURE`) → treated as paid, falls through to the branches above. So `?x402=1&fail=1` = "agent paid, then the upstream 5xx'd". Payment is **not verified** — it's a demo target. |

Toggles compose. There's also `GET /health` → `{"status":"ok",...}` and `GET /` → an HTML page listing all this.

Quick probes (no `pact`/`pay` needed):
```bash
curl -s  https://dummy.pactnetwork.io/health
curl -si https://dummy.pactnetwork.io/quote/AAPL?fail=1            # 503
curl -si https://dummy.pactnetwork.io/quote/AAPL?status=502        # 502
curl -si https://dummy.pactnetwork.io/quote/AAPL?x402=1            # 402 + x402 challenge
curl -si -H 'X-Payment: x' https://dummy.pactnetwork.io/quote/AAPL?x402=1            # 200 (paid)
curl -si -H 'Payment-Signature: x' 'https://dummy.pactnetwork.io/quote/AAPL?x402=1&fail=1'   # 503 (paid, then upstream down)
```

## Demo A — `pact pay` wraps pay.sh (works today, sandbox / fake money)

Prereqs: `npm i -g @q3labs/pact-cli` · the `pay` binary (solana-foundation/pay) · `pay setup` once (Touch ID → Keychain). `--sandbox` = a localnet wallet auto-funded with fake SOL/USDC; no mainnet gate needed.

**Beat 1 — happy path.** The agent calls a paid API; `pact pay` wraps it.
```bash
pact pay curl --sandbox 'https://dummy.pactnetwork.io/quote/AAPL?x402=1'
```
Expect: `pay` detects the 402, pays on localnet, retries with the payment header, the dummy returns `200` with the quote on **stdout**; then on **stderr**:
```
[pact] base 0.005 USDC + premium 0.000 ... (covered ...)
[pact] classifier: success  (status=200)
```
Narrate: "Same call as `pay curl`, plus Pact recorded a coverage verdict — success, nothing to refund."

**Beat 2 — the API breaks after the agent paid** (the case Pact exists for).
```bash
pact pay curl --sandbox 'https://dummy.pactnetwork.io/quote/AAPL?x402=1&fail=1'
```
Expect: `pay` pays, retries, the dummy returns `503`; on stderr:
```
[pact] classifier: server_error  (status=503)
[pact] policy: refund_on_server_error — refund 0.005 ... (settling on-chain)
[pact] check status: pact pay coverage <id>
```
Narrate: "The agent paid, the upstream failed — without Pact that money's gone. Pact flagged it as a covered breach; the USDC comes back."

**Beat 3 — the agent does it itself.** In Claude Code (with the `pact-pay` skill installed): *"get me an AAPL quote from `https://dummy.pactnetwork.io/quote/AAPL?x402=1` — it's a paid API."* The agent says *"🛡️ routing through `pact pay` — covered by Pact"* and runs the command. "It picks the right tool on its own."

> **Caveat:** the dummy's x402 challenge `payTo` is currently a placeholder address. On `--sandbox` `pay` must send fake USDC to it on localnet — usually fine, but if `pay --sandbox` errors on the recipient, that's the placeholder; the maintainer can swap it for a real address and redeploy. **Do NOT run mainnet `pact pay` against the dummy until the `payTo` is a real recoverable address.**

## Demo B — the gateway path (`pact <url>`), with on-chain refund — *needs setup*

This is the cleaner "look, here's the Solscan tx" version. It works once `dummy` is onboarded as a Pact gateway endpoint (on-chain `register_endpoint` + a Postgres `Endpoint` row + a market-proxy redeploy + the registry reload + a funded demo wallet — operator steps; see `docs/dummy-upstream-deploy.md` / `docs/premium-coverage-mvp.md`). When it is:
```bash
export PACT_MAINNET_ENABLED=1
pact approve 1.0                                              # one-time: delegate $1 USDC to Pact's SettlementAuthority
pact --json https://dummy.pactnetwork.io/quote/AAPL          # ok: premium ~0.001 USDC debited, no refund
pact --json https://dummy.pactnetwork.io/quote/AAPL?fail=1  # server_error: premium debited, refund settling on-chain
pact calls <id>                                              # → the settle_batch tx → https://solscan.io/tx/<sig>
pact --json https://dummy.pactnetwork.io/quote/AAPL?latency=2500  # latency_breach: refund
```
The Solscan tx shows the premium debit + the refund in one transaction. Net cost on a breach ≈ $0.

Until `dummy` is onboarded, `pact https://dummy.pactnetwork.io/...` returns `no_provider` — use Demo A instead, or run the gateway demo against an already-onboarded provider (`api.helius.xyz`, `public-api.birdeye.so`, `quote-api.jup.ag`, `lite-api.jup.ag`, `api.elfa.ai`, `fal.run`, `mainnet.helius-rpc.com`).

## Demo C (full, when the facilitator is deployed) — `pact pay` with on-chain settlement

Same as Demo A Beat 2 but mainnet + a real `payTo`:
```bash
export PACT_MAINNET_ENABLED=1
pact pay curl 'https://dummy.pactnetwork.io/quote/AAPL?x402=1&fail=1'   # real USDC payment → 503 → coverage registered
pact pay coverage <coverageId>                                          # → "settled" + the settle_batch Solscan link
```
Needs: the `facilitator.pact.network` service deployed, the `pay-default` coverage pool funded on-chain, a funded demo wallet with `pact approve`, and the dummy's `payTo` set to a real address. Operator steps in `docs/premium-coverage-mvp.md` (Part B) + `docs/facilitator-deploy.md`.

## What to say about the current state (be accurate)

- Demo A works **now** (sandbox, fake money) — it's the `pact pay` wrapper + the Pact classifier verdict. No on-chain settlement in `--sandbox`.
- Demo B's on-chain refund is **live for the 7 onboarded providers today**; for the `dummy` endpoint it needs the operator onboarding steps.
- Demo C (on-chain settlement of `pact pay`-wrapped calls via the `pay-default` pool) needs the facilitator deployed — it's built (`packages/facilitator/`), not yet deployed.
