# Hand-test: C-1 refund cap on the LIVE facilitator route

**Task:** Prove the agent-tasks#10 C-1 imputed-cost refund cap is enforced on the
**live** `POST /v1/coverage/register` HTTP route, using a **real** local agent
keypair signing the genuine ed25519 envelope, in **unverified** mode (no on-chain
payment check). Run once, save artifacts, leave a runbook.

**Branch:** `handtest-cap-10` (from `origin/crew/harden-c1-10` @ `8d0cf12`
"refactor(facilitator): enforce C-1 imputed-cost cap in computeEconomics
single-source-of-truth"). No `packages/` source modified.

---

## A. Verdict: **PASS**

The live facilitator route **capped the refund** on a huge client-supplied
`amountBaseUnits`, and **did not cap** when the amount was below the imputed-cost
ceiling. Both responses came back over real HTTP from a running facilitator
(`tsx src/index.ts`, gate OFF), against a real Postgres-seeded `pay-default` pool,
with the agent allowance check passing against **live devnet RPC** for a real,
provisioned keypair. The computed refunds were also published to Pub/Sub
(emulator) and pulled back as independent evidence.

## B. Observed vs expected

Pool config (DB-seeded `pay-default`): `flatPremium=1000`, `imputedCost=1000000`.
Cap rule (`packages/wrap/src/economics.ts::computeEconomics`):
`refund = min(amountPaid, imputedCost) + flatPremium`.

| Call | `amountBaseUnits` | Expected refund | **Observed `refundBaseUnits`** | Capped? | Result |
|------|------------------:|----------------:|-------------------------------:|---------|--------|
| (a) | `9999999999` | `1001000` (= 1000000 + 1000) | **`1001000`** | YES — clamped to imputed+premium | PASS |
| (b) | `500000` | `501000` (= 500000 + 1000) | **`501000`** | NO — amount < imputed, passes through | PASS |

Both: `status=settlement_pending`, `premiumBaseUnits=1000`, `outcome=server_error`,
`poolSlug=pay-default`, `verified=false` (unverified mode — `payee` +
`paymentSignature` omitted, so no on-chain check ran). The difference between the
two is **entirely** the cap: a ~10,000x-larger claim yields the *same* `1001000`
ceiling, while the sub-ceiling claim is refunded in full.

Independent Pub/Sub evidence (`artifacts/pubsub-events.json`) — the events the
live route published to the shared settlement topic:

```
callId=a6762b86-... outcome=server_error premium=1000 refund=1001000 verdictSource=client_attested verified=false
callId=2363add3-... outcome=server_error premium=1000 refund=501000  verdictSource=client_attested verified=false
```

`verdictSource=client_attested` confirms the agent-tasks#10 provenance tag on the
trust-bounded path; the refund values match the HTTP responses exactly.

> Note: the facilitator does **not** log the computed refund on the success path
> (by design — it only warns on Pub/Sub/allowance failure). The authoritative
> "computed refund" evidence is therefore the HTTP response bodies
> (`capped.json` / `uncapped.json`) **and** the published Pub/Sub events
> (`pubsub-events.json`), not `facilitator.log`.

## C. Exact hand commands for Tu

Prereqs: `docker`, `pnpm` (run `pnpm install` + build wrap once), `node`,
`solana`/`spl-token` CLIs (only for manual ATA inspection, not required by the
scripts). The agent wallet is auto-selected: it prefers
`~/.config/pact/hand-test/wallet.json`, and falls back to
`~/.config/pact/pact-smoke/wallet.json` — picking the first whose **devnet USDC
ATA** has balance + delegated allowance ≥ premium. In this run the hand-test
wallet was unprovisioned (0 SOL / no ATA), so the provisioned **pact-smoke**
wallet (`Hr7XX…`, ATA `4yL1T…`, balance 19.998 USDC, delegatedAmount 0.998 USDC)
was used — exactly the documented fallback.

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network/.worktrees/pact-network-handtest-cap

# one-time: deps + build the wrap dep the facilitator imports (dist)
pnpm install
pnpm --filter @pact-network/wrap... build

# 1) bring up Postgres + Pub/Sub emulator, migrate+seed pay-default, start facilitator
bash .planning/smoke/pay-cap-handtest/start-harness.sh

# 2) fire the two signed calls (capped + uncapped) and pull the published events
bash .planning/smoke/pay-cap-handtest/call-cap-test.sh

# 3) tear everything down (kills facilitator, removes containers)
bash .planning/smoke/pay-cap-handtest/stop-harness.sh
```

Single capped call by hand (any cwd; dependency-free signer):

```bash
source .planning/smoke/pay-cap-handtest/harness.env
node .planning/smoke/pay-cap-handtest/sign-register.mjs \
  --wallet ~/.config/pact/pact-smoke/wallet.json \
  --amount 9999999999 --asset "$USDC_MINT" --url http://localhost:8080
# -> {"status":"settlement_pending","premiumBaseUnits":"1000","refundBaseUnits":"1001000",...}
```

Boot config (devnet values from `packages/{settler,market-proxy}/.env.devnet.example`;
RPC is the **public** devnet endpoint — the facilitator only needs RPC for the
allowance read, no Helius key required):

```
PG_URL=postgresql://pact:pact@localhost:5544/pact
RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5
USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
PUBSUB_PROJECT=pact-handtest  PUBSUB_TOPIC=pact-settle-events  PUBSUB_EMULATOR_HOST=localhost:8685
PAY_DEFAULT_SLUG=pay-default  PACT_VERDICT_ATTESTATION_GATE=off  PORT=8080
```

## D. Artifact file list

All under `.planning/smoke/pay-cap-handtest/`:

Scripts / runbook:
- `start-harness.sh` — docker up + `prisma db push` + seed + topic/sub create + start facilitator (gate OFF), log → `facilitator.log`
- `call-cap-test.sh` — selects provisioned wallet, fires the two signed calls, pulls Pub/Sub events, tails log
- `stop-harness.sh` — kills facilitator + removes containers
- `sign-register.mjs` — dependency-free ed25519 envelope signer (replicates `pact-cli` byte-for-byte; never prints the secret)
- `pick-wallet.mjs` — dependency-free devnet ATA prober that chooses a provisioned agent wallet
- `pull-events.mjs` — pulls published `SettlementEvent`s from the Pub/Sub emulator
- `harness.env` — boot config (sourced by the scripts)

Evidence (`.planning/smoke/pay-cap-handtest/artifacts/`):
- `capped.json` — HTTP response for amount=9999999999 → `refundBaseUnits=1001000`
- `uncapped.json` — HTTP response for amount=500000 → `refundBaseUnits=501000`
- `capped.request.json` / `uncapped.request.json` — exact request bodies + canonical payload + headers (no secrets)
- `pubsub-events.json` — the two `SettlementEvent`s the route published (refund + `verdictSource`)
- `pubsub-pull.out` / `pubsub-setup.out` — Pub/Sub pull summary + topic/sub list
- `facilitator.log.excerpt` — facilitator stdout tail (boot line; no refund logging on success path by design)
- `wallet-pick.out` — which wallet was chosen and why (balance/delegation)
- `db-endpoint-row.out` / `db-seed.out` — seeded `pay-default` pool row
- `docker-state.out` — running harness containers
- `harness.env.redacted` — boot config (RPC normalized to the public endpoint)

## E. Blockers / caveats

- **None blocking.** The test passed end-to-end on the live route.
- **Wallet provisioning:** the named primary wallet `~/.config/pact/hand-test/wallet.json`
  is **not** provisioned on devnet (0 SOL, no USDC ATA). Without a USDC ATA that
  has balance + delegation ≥ premium, the route returns `uncovered / no_allowance`
  and the refund is never computed (so the cap can't be observed). The harness
  auto-falls back to the provisioned `pact-smoke` wallet, as the task's fallback
  clause anticipated. To use the hand-test wallet specifically, fund it with
  devnet SOL + the devnet USDC mint and run `pact approve`.
- **Cap is off-chain math, not the on-chain exposure cap.** This proves the
  per-call C-1 imputed-cost ceiling enforced in `computeEconomics` (the
  HTTP-route + published-event layer). The on-chain hourly `exposure_cap_per_hour`
  in `settle_batch` is a separate, additional backstop and is **not** exercised
  here (no settler / no on-chain settlement in this harness — `settlement_pending`
  is as far as the route goes).
- **`bigint` native-binding warning** in `facilitator.log` ("Failed to load
  bindings, pure JS will be used") is benign — `@solana/spl-token`'s optional
  native dep; it falls back to pure JS and does not affect the result.
- Public devnet RPC was used for the allowance read; if rate-limited, swap
  `RPC_URL` for a Helius devnet URL in `harness.env`.
