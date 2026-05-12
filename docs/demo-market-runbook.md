# Pact Market Gateway Demo ("Demo B") — Runbook

This is the runbook for the `pact <url>` insured-call demo: an agent calls a paid
API through Pact's market gateway against the live demo upstream
`https://dummy.pactnetwork.io`, and refunds settle on **Solana mainnet**.

> Scope: this is the **gateway** path only (`pact <url>` → `api.pactnetwork.io`).
> The separate `pact pay` path (wrapping `solana-foundation/pay` for arbitrary
> x402/MPP endpoints, settling via `facilitator.pactnetwork.io`) is out of scope
> here — see [`docs/premium-coverage-mvp.md`](./premium-coverage-mvp.md).

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

**CLI**
`@q3labs/pact-cli@0.2.3` is published to npm — multi-platform (macOS / Linux /
Windows).

---

## 3. One-time setup on the demo machine

```bash
npm i -g @q3labs/pact-cli              # 0.2.3

export PACT_MAINNET_ENABLED=1          # closed-beta gate — required for the mainnet path

export PACT_RPC_URL="https://solana-mainnet.g.alchemy.com/v2/pi-qzAdsrf0GvKlNIOzwk"
# Any mainnet RPC works. A WS-capable endpoint avoids the `signatureSubscribe`
# noise on `pact approve` (see Gotchas).
```

### Demo-agent wallet

You need a Solana keypair funded on **mainnet** with **≥ ~0.5 USDC** and
**≥ ~0.01 SOL**.

> **Keypair format.** With `pact-cli` 0.2.3, `PACT_PRIVATE_KEY` expects a
> **base58-encoded secret key**, *not* a `solana-keygen` JSON-array keypair file.
> Convert a JSON keypair file to base58:
>
> ```bash
> PACT_PRIVATE_KEY="$(node -e 'const bs58=require("bs58").default||require("bs58"); process.stdout.write(bs58.encode(Buffer.from(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))))' /path/to/keypair.json)"
> export PACT_PRIVATE_KEY
> ```
>
> `pact-cli` ≥ 0.2.4 (when published) accepts a JSON-array keypair or a file path
> directly via `PACT_PRIVATE_KEY`, or via a `--keypair <path>` flag — until then,
> base58.

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

## 4. Running the demo

```bash
# Warm the Vercel upstream first — avoids cold-start latency on camera.
curl -s https://dummy.pactnetwork.io/health
```

**Success — premium only, no refund:**

```bash
pact --json https://dummy.pactnetwork.io/quote/AAPL
# → {"status":"ok","body":{"symbol":"AAPL","price":"287.90",...},
#    "meta":{"slug":"dummy","call_id":"<id>","outcome":"ok",
#             "premium_usdc":0.001,"settlement_eta_sec":8}}
```

**The headline — upstream 5xx's after the agent paid → on-chain refund:**

```bash
pact --json https://dummy.pactnetwork.io/quote/AAPL?fail=1
# → {"status":"server_error","body":{"error":"upstream_unavailable",...},
#    "meta":{"slug":"dummy","call_id":"<id>","outcome":"server_error",
#             "premium_usdc":0.001,"settlement_eta_sec":8}}
```

**Latency-breach variant (2.5s > the 2s SLA) → also refunds:**

```bash
pact --json https://dummy.pactnetwork.io/quote/AAPL?latency=2500
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

## 5. Have the agent do it (optional)

`pact init` in a project installs the broader `pact` skill into
`.claude/skills/pact/SKILL.md` (plus a `CLAUDE.md` snippet). This repo also ships
`packages/cli/skills/pact-pay/` and `packages/cli/skills/pact-demo/` skills you
can copy into `~/.claude/skills/`.

With those installed, a Claude Code agent routes paid calls through `pact <url>`
automatically and announces when coverage kicked in — so the demo becomes "ask
the agent to call the flaky API, watch it self-insure."

---

## 6. Gotchas / FAQ

- **`signatureSubscribe` errors on `pact approve`.** If the RPC URL doesn't serve
  WebSocket subscriptions over HTTP (e.g. the Alchemy HTTP endpoint), `pact
  approve` prints:
  ```
  Received JSON-RPC error calling 'signatureSubscribe' { ... Method 'signatureSubscribe' not found }
  ```
  repeatedly. **The transaction still lands fine** — it's just confirmation-
  polling noise. Use a WS-capable RPC, or ignore it.

- **Command is `pact calls show <id>`**, not `pact calls <id>`.

- **Cold starts.** The dummy upstream is on Vercel — a cold start adds ~1–4s to
  the first request. `curl …/health` first.

- **Two different paths.** This runbook is the **gateway** path
  (`pact <url>` → `api.pactnetwork.io`). There's a separate `pact pay` path
  (wraps `solana-foundation/pay` for arbitrary x402/MPP endpoints, settles via
  `facilitator.pactnetwork.io`) — out of scope here; see
  [`docs/premium-coverage-mvp.md`](./premium-coverage-mvp.md).

- **Cloud Armor blocks default user-agents.** `api.pactnetwork.io` sits behind
  Cloud Armor that 403s default `curl` / Node user-agents. The `pact` CLI sends
  its own UA, so it's fine. If you `curl` the gateway directly for debugging,
  pass `-H "User-Agent: pact-monitor-sdk/0.1.0"` (or a browser UA).
