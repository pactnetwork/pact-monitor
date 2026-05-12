# Pact Market Demo — Runbook (Demo B + Demo C)

Two demos against the live deliberately-flaky upstream `https://dummy.pactnetwork.io`,
both settling on **Solana mainnet**:

- **Demo B — the gateway path.** An agent calls a paid API through Pact's market
  gateway (`pact <url>` → `api.pactnetwork.io`). Premium in, refund out on an SLA
  breach. §§ 1–6 below.
- **Demo C — the `pact pay` path.** An agent makes an x402 payment with
  `solana-foundation/pay`, wrapped by `pact pay`; the receipt + verdict register
  with `facilitator.pactnetwork.io`, which settles a refund from the shared
  `pay-default` coverage pool when the paid call breaches. § 7 below.

Both run from the same machine with the same CLI and the same demo wallet — only
the command differs. Demo B is the cleaner "here's the Solscan tx" story; Demo C
is the "I wrapped `pay` and got my money back when the API died" story.

See also [`docs/premium-coverage-mvp.md`](./premium-coverage-mvp.md) for the
deeper operator/architecture notes.

---

## 1. What it demonstrates

An AI agent calls a paid API through Pact (`pact <url>` instead of `fetch`). On
every call Pact charges a tiny per-call premium into the provider's on-chain
coverage pool. If the upstream breaches its SLA — a 5xx, or a latency overrun —
Pact settles a refund back to the agent **on-chain, automatically, in ~40–50
seconds**, verifiable on Solscan. Net cost on a failed call is roughly **$0**;
for the demo endpoint the refund is 10× the premium, so on a breach the agent
actually nets positive.

---

## 2. Already live — no setup needed

These are deployed and configured. Nothing to do here; just know they exist.

**Demo upstream — `https://dummy.pactnetwork.io`**
A deliberately-flaky "price quote" API on Vercel. Routes:

| Route | Behavior |
|---|---|
| `GET /health` | Liveness check (use it to warm the Vercel cold start). |
| `GET /quote/:symbol` | Returns a fake price quote. |
| `GET /quote/:symbol?fail=1` | Responds `503`. |
| `GET /quote/:symbol?status=<n>` | Responds with status `<n>`. |
| `GET /quote/:symbol?latency=<ms>` | Sleeps `<ms>` ms, then responds. |
| `GET /quote/:symbol?body=<s>` | Echoes `<s>` in the response body. |

**`dummy` provider — onboarded as the 6th Pact Market gateway provider**

| Thing | Value |
|---|---|
| `EndpointConfig` PDA | `CoEuw3mGqwwHxXkuQgeKNdkNGbUqeMkfeGRykPedjpvh` |
| Slug | `dummy` |
| `flatPremiumLamports` | `1000` ($0.001 / call) |
| `slaLatencyMs` | `2000` |
| `imputedCostLamports` | `10000` ($0.01 refunded on a covered breach) |
| `exposureCapPerHourLamports` | `1000000` ($1.00 / hr cap) |
| `CoveragePool` PDA | `GAnhVQnVcPSp7zgaEsvPiY4peDpokmTqr2RXmTLSYtxx` (funded 1.0 USDC) |
| Postgres `Endpoint` row | present in the market-proxy DB |

**Gateway — `https://api.pactnetwork.io`**
Deployed at revision `pact-market-proxy-00015-lzj` with the `dummy` handler.

**On-chain references (mainnet)**

| Thing | Value |
|---|---|
| Program ID | `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` |
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

**Facilitator — `https://facilitator.pactnetwork.io`** (used by Demo C)
Cloud Run service `pact-facilitator`, wired into the LB, Cloud SQL + Direct VPC
egress. `GET /health` → `{"status":"ok","service":"pact-facilitator",...}`.
Coverage pool `pay-default` is registered + funded on-chain.

**The dummy's x402 mode** (used by Demo C): `GET /quote/:symbol?x402=1` makes the
dummy act as an x402 server — a request without a payment header returns `402` +
an x402 challenge; the retry with a payment header is treated as paid and falls
through to the `?fail` / `?status` / `?latency` branches above. Its challenge
`payTo` is `5jMLJ6EuGVqyruN2eyf3GoVUnRUpn3h8vUVxp84DmcCf` — i.e. the pre-set demo
wallet (see § 3), so on mainnet `pact pay` against the dummy is a **self-pay** of
$0.005 USDC (you pay yourself; only the network fee is real).

**CLI**
`@q3labs/pact-cli@0.2.6` is published to npm — multi-platform (macOS arm64/x64,
Linux arm64/x64, Windows x64). `npm i -g @q3labs/pact-cli` picks the right binary
for your Mac automatically.

---

## 3. One-time setup on the demo machine

```bash
npm i -g @q3labs/pact-cli              # 0.2.6+

export PACT_MAINNET_ENABLED=1          # closed-beta gate — required for the mainnet path

export PACT_RPC_URL="https://solana-mainnet.g.alchemy.com/v2/pi-qzAdsrf0GvKlNIOzwk"
# Any mainnet RPC works. A WS-capable endpoint avoids the `signatureSubscribe`
# noise on `pact approve` (see Gotchas).

# For Demo C only — point pact pay at the deployed facilitator:
export PACT_FACILITATOR_URL="https://facilitator.pactnetwork.io"
```

For **Demo C** you also need the `solana-foundation/pay` CLI installed and set up
once:

```bash
# install per https://github.com/solana-foundation/pay (Homebrew tap or release binary), then:
pay setup        # provisions a Solana keypair into the macOS Keychain (Touch ID)
```

> Demo C runs `pay` under the hood — `pact pay <args>` forwards `<args>` verbatim
> to `pay`. The wallet that *signs the x402 payment* is `pay`'s own Keychain
> wallet; the wallet that signs Pact's coverage registration is `PACT_PRIVATE_KEY`
> (the demo wallet below). For a self-contained demo, keep them the same — import
> the demo keypair into `pay` too (`pay account import …`) — or just let `pay`
> use its Keychain wallet and fund that one instead.

### Demo-agent wallet

You need a Solana keypair funded on **mainnet** with **≥ ~0.5 USDC** and
**≥ ~0.01 SOL**.

> **Keypair format.** With `pact-cli` ≥ 0.2.4, you have three options, in
> precedence order:
> 1. `pact --keypair /path/to/keypair.json <cmd> …` — a `solana-keygen` JSON-array
>    file (works for `pact pay` too: `pact --keypair … pay curl …` — the flag is
>    global, so it goes *before* the subcommand).
> 2. `export PACT_PRIVATE_KEY=…` — accepts a base58 secret key, a JSON byte-array
>    string, **or** a path to a keypair file.
> 3. The on-disk wallet `pact init` / `pact wallet` manages.
>
> If you specifically need a base58 string, convert a JSON keypair file:
>
> ```bash
> PACT_PRIVATE_KEY="$(node -e 'const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";const b=Buffer.from(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));let d=[0];for(const x of b){let c=x;for(let j=0;j<d.length;j++){c+=d[j]<<8;d[j]=c%58;c=(c/58)|0;}while(c){d.push(c%58);c=(c/58)|0;}}let s="";for(const x of b){if(x===0)s+="1";else break;}for(let j=d.length-1;j>=0;j--)s+=A[d[j]];process.stdout.write(s);' /path/to/keypair.json)"
> export PACT_PRIVATE_KEY
> ```

### Delegate a USDC allowance (one time)

```bash
pact approve 1.0          # delegates a $1 USDC allowance to Pact's SettlementAuthority
                          # — the funds never leave your wallet

pact balance
# → {"wallet":"...","ata_balance_usdc":...,"allowance_usdc":1,"eligible":true}
#   `eligible:true` means you're ready.
```

> **There's a pre-set demo wallet on file** if you'd rather not make your own:
> pubkey `5jMLJ6EuGVqyruN2eyf3GoVUnRUpn3h8vUVxp84DmcCf` — funded 2 USDC + 0.02
> SOL, with a 1.0 USDC allowance already in place. Ask the maintainer for the
> key.

---

## 4. Running Demo B — the gateway path (`pact <url>`)

> **Quote every URL that has a `?`.** In zsh (the macOS default) an unquoted
> `...AAPL?fail=1` is a glob and you'll get `zsh: no matches found`. Always
> single-quote: `pact --json 'https://...?fail=1'`.

```bash
# Warm the Vercel upstream first — avoids cold-start latency on camera.
curl -s https://dummy.pactnetwork.io/health
```

**Success — premium only, no refund:**

```bash
pact --json 'https://dummy.pactnetwork.io/quote/AAPL'
# → {"status":"ok","body":{"symbol":"AAPL","price":"287.90",...},
#    "meta":{"slug":"dummy","call_id":"<id>","outcome":"ok",
#             "premium_usdc":0.001,"settlement_eta_sec":8}}
```

**The headline — upstream 5xx's after the agent paid → on-chain refund:**

```bash
pact --json 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'
# → {"status":"server_error","body":{"error":"upstream_unavailable",...},
#    "meta":{"slug":"dummy","call_id":"<id>","outcome":"server_error",
#             "premium_usdc":0.001,"settlement_eta_sec":8}}
```

**Latency-breach variant (2.5s > the 2s SLA) → also refunds:**

```bash
pact --json 'https://dummy.pactnetwork.io/quote/AAPL?latency=2500'
```

You can also let `pact` poll the settlement for you instead of checking by hand:

```bash
pact --wait --json 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'
# blocks ~10–50s, then the returned meta has tx_signature + solscan_url filled in
```

**Check the on-chain settlement (~10–50s after the call):**

```bash
pact calls show <call_id>
# → {"callId":"<id>","endpointSlug":"dummy","premiumLamports":"1000",
#    "refundLamports":"10000","breach":true,"breachReason":"server_error",
#    "signature":"<settle_batch tx sig>","recipientShares":[...]}
```

Then open `https://solscan.io/tx/<settle_batch tx sig>` — it shows the premium
debited and the refund paid out, in a single transaction.

### Verified example settlements (mainnet, 2026-05-12)

Use these as backups in a video if a live settlement is slow on camera:

- **Breach (refund)** — `settle_batch` tx
  `2eW69aYYE3UZ6EYCr147FgpwQu5zWLANMosqz8qyEuZDRtV8X9rCJ5yVzoyJpGUdcN4m1WsfJ6Gwbb6ZtEHHUYpK`
- **Success (premium only)** — `settle_batch` tx
  `4XxvqT2R5mtxtSZDxT5iNbQuN9monopYSaRpM3L9HrTGGKj58qarPqoD7qNV96x4CA8Mh58dNL8njJ3W4a52mE5a`

---

## 5. Running Demo C — the `pact pay` path (wraps `solana-foundation/pay`)

Same flaky upstream, but this time the agent *pays* for the call with an x402
payment (via `pay`), and `pact pay` registers the receipt + verdict with the
facilitator. On a breach, the refund settles from the shared `pay-default`
coverage pool.

Prereqs (one-time, from § 3): `npm i -g @q3labs/pact-cli` · `pay` installed +
`pay setup` · `export PACT_MAINNET_ENABLED=1 PACT_FACILITATOR_URL=https://facilitator.pactnetwork.io PACT_RPC_URL=… PACT_PRIVATE_KEY=…`
· `pact approve 1.0` done · the demo wallet funded (≥ ~0.5 USDC + ~0.01 SOL).

```bash
# Warm both the upstream and the facilitator (Cloud Run cold start):
curl -s https://dummy.pactnetwork.io/health
curl -s https://facilitator.pactnetwork.io/health
```

**Happy path — agent pays, call succeeds → coverage recorded, nothing to refund:**

```bash
pact pay --json curl 'https://dummy.pactnetwork.io/quote/AAPL?x402=1'
# pay detects the 402, pays $0.005 USDC to the dummy's payTo (= the demo wallet,
# so this is a self-pay), retries with the payment header, gets the 200 quote.
# → meta.coverage: {"status":"settlement_pending"|"covered","premiumBaseUnits":"1000",
#                   "refundBaseUnits":"0","pool":"pay-default", ...}
```

**The headline — agent pays, then the upstream 5xx's → refund from `pay-default`:**

```bash
pact pay --json curl 'https://dummy.pactnetwork.io/quote/AAPL?x402=1&fail=1'
# → ...
#   "body":{"classifier":"server_error","upstream_status":503,
#           "payment":{"attempted":true,"signed":true,"amount":"0.005","asset":"USDC",
#                      "amountBaseUnits":"5000","scheme":"x402", ...}},
#   "meta":{"coverage":{"id":"<coverageId>","status":"settlement_pending",
#                       "premiumBaseUnits":"1000","refundBaseUnits":"5000",
#                       "pool":"pay-default"}}
```

Without `--json` you get the human lines on stderr instead:

```
[pact-http-status=503]
[pact] base 0.005 USDC + premium 0.001 ... (covered by pay-default)
[pact] classifier: server_error  (status=503, reason=upstream 503)
[pact] policy: refund_on_server_error — refund 0.005 USDC (settling on-chain)
[pact] check status: pact pay coverage <coverageId>
```

**Check the on-chain settlement:**

```bash
pact pay coverage <coverageId>
# → ...{"status":"settlement_pending"|"settled","settled":true,
#       "settleBatchSignature":"<sig>"}...
```

When `settled` flips true, open `https://solscan.io/tx/<settleBatchSignature>` —
the `settle_batch` tx shows the premium debit + the $0.005 refund out of the
`pay-default` pool.

> **Settler cadence.** The on-chain `settle_batch` for `pact pay`-registered
> coverage is done by the settler on its batch cycle — it can take a couple of
> minutes, longer than Demo B's ~40s gateway settle. The `coverageId` and amounts
> are confirmed the instant `pact pay` returns; the Solscan tx follows. For a
> video, register the coverage a few minutes before you film the `pact pay
> coverage` check, or use a backup tx (below).

> **`?x402=1` is required for Demo C.** Without it the dummy is a plain HTTP API —
> `pay` sees no 402 challenge, makes no payment, and `pact pay` correctly reports
> "no charge — no 402". `?x402=1&fail=1` = "agent paid, then the upstream died",
> which is the case Pact exists for.

### Verified example (mainnet, 2026-05-12)

- Coverage `cd6530c9-9320-4961-ab49-04cf20bcae35` — `pact pay curl
  '…?x402=1&fail=1'` → registered against `pay-default`, premium `1000`
  ($0.001), refund `5000` ($0.005), settled on-chain:
  `settle_batch` tx
  `3WGRGWX5uDCMjB9TP1mimb4PA6hCrxaHXfrxB6jgKsupQNG5uEp2VL1UWH9EiUx7kZLdTwoH6KKXuNV3fNy5iuDL`
  ([Solscan](https://solscan.io/tx/3WGRGWX5uDCMjB9TP1mimb4PA6hCrxaHXfrxB6jgKsupQNG5uEp2VL1UWH9EiUx7kZLdTwoH6KKXuNV3fNy5iuDL)).

---

## 6. Have the agent do it (optional)

`pact init` in a project installs the broader `pact` skill into
`.claude/skills/pact/SKILL.md` (plus a `CLAUDE.md` snippet). This repo also ships
`packages/cli/skills/pact-pay/` and `packages/cli/skills/pact-demo/` skills you
can copy into `~/.claude/skills/`.

With those installed, a Claude Code agent routes paid calls through `pact <url>`
(gateway) or `pact pay …` (x402) automatically and announces when coverage
kicked in — so the demo becomes "ask the agent to call the flaky API, watch it
self-insure." The `pact-demo` skill is keyed on phrases like *"use dummy
services"* / *"demo Pact coverage"* and knows the exact commands and toggles for
both Demo B and Demo C.

---

## 7. Gotchas / FAQ

- **`signatureSubscribe` errors on `pact approve`.** If the RPC URL doesn't serve
  WebSocket subscriptions over HTTP (e.g. the Alchemy HTTP endpoint), `pact
  approve` prints:
  ```
  Received JSON-RPC error calling 'signatureSubscribe' { ... Method 'signatureSubscribe' not found }
  ```
  repeatedly. **The transaction still lands fine** — it's just confirmation-
  polling noise. Use a WS-capable RPC, or ignore it.

- **Command is `pact calls show <id>`** (Demo B), not `pact calls <id>`. For
  Demo C it's `pact pay coverage <coverageId>`.

- **Quote `?`-bearing URLs in zsh** — unquoted `…?fail=1` → `zsh: no matches
  found`. Single-quote the whole URL.

- **Cold starts.** The dummy upstream is on Vercel and the facilitator is on
  Cloud Run — a cold start adds ~1–10s to the first request. `curl …/health`
  on both first.

- **`pact pay` says "facilitator unreachable — operation was aborted".** That's
  the CLI's 8s timeout on the coverage POST firing because the facilitator is
  blocked on something server-side (it took >8s to respond). Most likely cause:
  the facilitator can't reach Cloud SQL. Check
  `gcloud run services logs read pact-facilitator --region asia-southeast1` for
  `Cloud SQL connection failed … timed out` — fix is to make sure the service has
  Direct VPC egress (`run.googleapis.com/network-interfaces` +
  `vpc-access-egress: private-ranges-only`, plus the `cloudsql-instances`
  annotation). This was hit and fixed on 2026-05-12.

- **`pay` not initialized.** `pact pay` prints a "pay.sh has not been initialized
  on this host" note if `pay setup` was never run / no Keychain wallet. Run `pay
  setup` (or import a keypair: `pay account import …`).

- **Two paths, two settlers.** Demo B = gateway (`pact <url>` →
  `api.pactnetwork.io`, settles ~40s, per-endpoint `dummy` pool). Demo C =
  `pact pay` (wraps `pay`, registers with `facilitator.pactnetwork.io`, settles
  on the settler's batch cycle, shared `pay-default` pool). Deeper notes:
  [`docs/premium-coverage-mvp.md`](./premium-coverage-mvp.md).

- **Cloud Armor blocks default user-agents.** `api.pactnetwork.io` sits behind
  Cloud Armor that 403s default `curl` / Node user-agents. The `pact` CLI sends
  its own UA, so it's fine. If you `curl` the gateway directly for debugging,
  pass `-H "User-Agent: pact-monitor-sdk/0.1.0"` (or a browser UA). The
  facilitator and the dummy upstream are *not* behind Cloud Armor — plain `curl`
  works there.
