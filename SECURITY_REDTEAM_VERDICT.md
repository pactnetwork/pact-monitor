# SECURITY_REDTEAM_VERDICT — accept-and-monitor for agent-tasks#10

> Adversarial red-team of the x402 / `pact pay` verdict-trust hole and the
> proposed **accept-and-monitor** direction. Authored 2026-06-11 on branch
> `spike/verdict-source-10`. Every claim cites `file:line` against the code on
> this branch and was re-verified independently of `MECHANISM_MAP.md`.
>
> Posture: I am the attacker. The conclusion is that accept-and-monitor as
> currently specced is **drainable to the on-chain cap on every breach claim,
> with zero real cost and zero risk to the attacker**, and that the one control
> the design leans on (the per-call `imputedCost` ceiling) **is not enforced on
> this path at all**. The pool's only real defense today is a single shared
> hourly exposure cap, which sybils share but do not multiply — so the drain is
> bounded but *continuous and free*, which is the worse failure mode for a
> subsidised launch float.

---

## 0. Verified economic parameters (the inputs every number below uses)

All values are the `pay-default` pool defaults. Confirmed in three places that
must agree (env default, TS seed, SQL seed):

| Param | Value (USDC base units, 6 dp) | $ | Source |
|---|---|---|---|
| `flatPremiumLamports` | `1_000` | $0.001 | `packages/db/seeds/pay-default-endpoint.ts:41`; `packages/facilitator/src/env.ts:29-32` (default `"1000"`) |
| `imputedCostLamports` ("per-call refund ceiling") | `1_000_000` | $1.00 | `pay-default-endpoint.ts:44`; `env.ts:39-42` (default `"1000000"`) |
| `exposureCapPerHourLamports` (per-pool, per-hour) | `5_000_000` | $5.00 | `pay-default-endpoint.ts:45`; `env.ts:52-55` (default `"5000000"`) |
| `MIN_PREMIUM_LAMPORTS` (on-chain floor) | `100` | $0.0001 | `packages/program/.../constants.rs:13` |
| `MAX_BATCH_SIZE` (settler TS) | `3` | — | `packages/settler/src/batcher/batcher.service.ts:20` |
| `MAX_BATCH_SIZE` (on-chain) | `50` | — | `constants.rs:12` (TS caps first, so 3 binds) |

Covered-breach refund formula (both paths): `refund = principal + flatPremium`
(`packages/wrap/src/economics.ts:95-96`). On the x402 path
`principal = amountBaseUnits` — **the client's claimed amount**
(`packages/facilitator/src/routes/coverage.ts:257` → `computeCoverage` →
`economics.ts:95`).

**The exposure cap is PER-ENDPOINT, not per-agent.** `settle_batch` reads
`current_period_refunds` / `exposure_cap_per_hour_lamports` off the single
`EndpointConfig` PDA for slug `pay-default`
(`settle_batch.rs:404-423`). There is exactly one pay-default pool
(`coverage.ts:227`, `poolSlugFor` always returns the default —
`packages/facilitator/src/lib/coverage.ts:189-191`). So **N sybil agents share
one $5/hr bucket; they do not each get their own.** This is the single most
important number in this document.

---

## 1. ATTACK ENUMERATION

### A-1 — Verdict forgery (malicious client, unverified mode) — the headline bug

**Preconditions:** one ed25519 keypair (free to generate; no on-chain
registration to "be an agent"), a USDC ATA with a `pact approve` allowance
covering one premium ($0.001), and an HTTP client. No merchant, no real payment,
no `pay` binary required.

**Steps:**
1. Build the canonical signature payload and sign it with the agent key
   (`packages/cli/src/lib/transport.ts::buildSignaturePayload`; verified by
   `verify-signature.ts:160-168`). This is the *only* auth gate.
2. `POST /v1/coverage/register` with `verdict:"server_error"` (or
   `network_error` / `latency_breach` — any covered breach), `payee` and
   `paymentSignature` **omitted** (`pay 0.16.0` legitimately omits them, so this
   is indistinguishable from honest traffic — `coverage.ts:69-82`).
3. Facilitator sets `verified = false` (`coverage.ts:162`), **skips
   `verifyPayment` entirely** (`coverage.ts:222-224`), trusts the verdict
   (only checks it is a well-formed enum — `coverage.ts:186`), and computes
   `refund = amountBaseUnits + flatPremium` (`coverage.ts:250-258`).
4. The event is published (`coverage.ts:329`), batched, and `settle_batch`
   pays the refund from the pool to the agent's ATA
   (`settle_batch.rs:464-485`), clamped only by the hourly cap.

**Net per claim:** `refund − premium − gas` = `($amountClaimed + $0.001) −
$0.001 − ~$0` = **`$amountClaimed`, pure profit.** Gas is paid by the *settler*
(SettlementAuthority signer), not the attacker — the attacker pays *nothing* but
the recoverable $0.001 premium, which is itself refunded inside the payout.
Break-even is immediate; ROI is effectively infinite (cost ≈ 0).

**File:line that makes it possible:** `coverage.ts:186` (enum-only verdict
check), `coverage.ts:222-224` (verifyPayment skipped when unverified),
`coverage.ts:257` + `economics.ts:91-96` (refund built from trusted verdict).

---

### A-2 — Inflated-principal claim (malicious client, unverified mode) — STRICTLY WORSE than A-1

**This is a finding the brief did not name and the design's own "per-call
ceiling" does not stop.** On the unverified path, `amountBaseUnits` is
validated only as `> 0` (`coverage.ts:177-185`). It is **never cross-checked
against anything** (no payment exists to check it against) and **never clamped
by `imputedCostLamports`**. I grepped the entire facilitator + wrap + settler
TS surface for any `min(amountPaid, imputedCost)` / refund clamp: the *only*
reference to `imputedCost` outside the config plumbing is in the advertised
discovery doc (`well-known.ts:37`, labelled `perCallRefundCeilingBaseUnits`).
**`computeCoverage`/`computeEconomics` never apply it** (`coverage.ts:251-258`,
`economics.ts:95`). The settler threads `refundLamports` verbatim
(`submitter.service.ts:319-324`).

**Consequence:** the attacker submits `amountBaseUnits:"5000000000"` ($5000) and
the facilitator authorizes a $5000 refund. The advertised "$1.00 per-call
ceiling" is **security theater on this path** — it exists only in the
`/.well-known` JSON, not in the money math. The on-chain hourly cap is the
*only* thing that actually clamps it (`settle_batch.rs:408-417` clamps to
`cap_remaining`, sets `ExposureCapClamped`).

**Why it matters even though the cap clamps it:** A-2 means a *single* register
call drains the *entire* remaining hourly cap in one shot. The attacker doesn't
need to pace 5,000 claims of $1; one claim of "$5000" empties the $5 bucket
instantly and deterministically. It also means the moment the cap is raised
(it will be — $5/hr is a demo number), the per-call blast radius scales 1:1 with
the cap, because nothing else bounds a single claim.

**File:line:** `coverage.ts:183-185` (`> 0` only), `economics.ts:95` (principal
= amountPaid, unclamped), absence of any `imputedCost` clamp in `economics.ts` /
`coverage.ts` (verified by grep).

---

### A-3 — Sybil fan-out against the shared cap (malicious client, N agents)

**Preconditions:** N keypairs, each with a USDC ATA + one-premium allowance
($0.001 each). Generating keypairs and ATAs is the only cost (ATA rent ~0.002
SOL each, *recoverable* on close; premium is refunded inside the payout).

**Steps:** run A-1/A-2 from N agents in parallel.

**What sybils buy you — and what they don't:** Because the cap is per-pool
(§0), N agents do **not** multiply the hourly drain — they share the same $5/hr
bucket. So sybils are **not** a throughput multiplier here. What they *do* buy:
1. **Attribution laundering** — spreads the breach claims across many pubkeys so
   the per-agent analytics counter (`events.service.ts:221-243`, a *counter,
   not a gate*) never shows one agent with an anomalous breach rate.
2. **Survival of naive per-agent controls** — if you later add a per-agent cap
   *without* a network-baseline check, sybils defeat it for free.
3. **Front-running the honest queue** — N attacker agents racing
   `register` at each hourly rollover (`settle_batch.rs:404` resets the period)
   claim the fresh $5 before any honest user, a griefing DoS on the pool.

**File:line:** no per-agent cap exists (grepped facilitator/settler/indexer —
the only `per-agent` hits are an analytics map `events.service.ts:221` and
webhook fan-out, neither gating).

---

### A-4 — Cap-reset draining loop (malicious client) — turns a one-time $5 into a salary

**Preconditions:** A-1 working; a cron.

**Mechanics:** the cap is a *rolling* 1-hour window that resets lazily: the first
settled refund after `now > current_period_start + 3600` zeroes
`current_period_refunds` and restarts the clock (`settle_batch.rs:404-406`).
So the attacker drains $5, waits for the hour boundary, drains $5 again,
indefinitely.

**Exposure:** `$5/hr × 24 × 365 ≈ $43,800/yr` of pure pool bleed from a single
keypair, assuming the pool stays funded and the cap stays at $5. Raise the cap
and this scales linearly. The pool-depletion guard (`settle_batch.rs:470-477`,
status `PoolDepleted`) stops payout when the vault empties — so the *real*
ceiling is "drain the pool dry," and the cap only controls *how fast*.

**File:line:** `settle_batch.rs:404-423` (rolling reset + cap clamp),
`settle_batch.rs:470-477` (pool-balance clamp).

---

### A-5 — Gateway "manufactured real breach" (the brief's self-observation question)

**Question asked:** on the gateway path, where Pact self-observes, can a client
cheaply *engineer* a real upstream 5xx/timeout so Pact authoritatively records a
breach it manufactured?

**Answer: NO arbitrary-upstream version exists — and that's the one good news
in this report.** The gateway resolves the upstream from the **registry row for
the slug**, not from a client-supplied URL: `endpoint.upstreamBase`
(`packages/market-proxy/src/routes/proxy.ts:152`, fed to `handler.buildRequest`;
slug must resolve in `registry.get` `proxy.ts:31`, else 404). The attacker
cannot point Pact at an attacker-controlled 5xx server. So the read of
"manufacture a breach by hosting a 500" **does not apply to the gateway path.**

**But three *residual* gateway vectors are real and confirmed:**

- **A-5a — induce a real provider 5xx.** The attacker sends a request crafted to
  make the *real* allowlisted upstream (Helius/Birdeye/Jupiter/…) return 5xx or
  hang past the SLA — e.g. a malformed-but-accepted JSON-RPC batch, a
  deliberately expensive query that times out, or hammering a rate limit into a
  5xx. wrap self-observes the genuine 5xx/latency and pays
  `imputedCost + flatPremium` ($1.001) to the attacker's wallet
  (`wrap/src/classifier.ts:76-84`, `economics.ts:95`). This is a *real* breach,
  so no verdict forgery is needed; the attacker just farms provider flakiness.
  Refund recipient is the agent's own ATA (`settle_batch.rs:464-485`), and the
  attacker controls the agent. **Profit per farmed breach = $1.001 − $0.001
  premium = $1.00**, bounded by the same shared hourly cap.
- **A-5b — latency-breach farming via slow queries.** SLA is 10s
  (`slaLatencyMs: 10_000`). Any 2xx slower than 10s is a covered
  `latency_breach` (`classify.ts` slow branch, `classifier.ts:82-83`). An
  attacker who can reliably push a real provider past 10s (large pagination,
  cold cache, heavy compute endpoints like fal.ai) farms refunds on **successful
  responses they actually received** — they got the data *and* the refund.
- **A-5c — the gateway has NO `amountPaid`**, so A-2's inflated-principal bug
  does **not** exist on the gateway path (principal is the fixed
  `imputedCost`, `economics.ts:95` `amountPaid === undefined`). Gateway
  per-breach payout is fixed at $1.001. This is why the gateway is materially
  safer than x402: bounded per-call payout + no client-chosen upstream + true
  self-observation.

**File:line:** `proxy.ts:152` (upstream from registry, not client),
`classifier.ts:64-84` (real self-observed classification), `economics.ts:95`
(gateway principal fixed = imputed).

---

### A-6 — Colluding client + merchant (verified mode)

**Preconditions:** attacker controls both the paying agent AND the merchant
wallet (`payee`). A real on-chain USDC transfer between two wallets the attacker
owns.

**Steps:**
1. Agent really pays merchant `amountBaseUnits` of USDC on-chain (attacker pays
   themselves; net-zero minus Solana fees ~$0.0005).
2. Register with `verdict:"server_error"`, real `payee` + `paymentSignature`.
   `verifyPayment` passes — it only proves the payee received ≥ amount
   (`payment-verify.ts:99-108`); it has **no knowledge of the HTTP call outcome**
   (the whole point of agent-tasks#10).
3. Facilitator pays `refund = amountPaid + flatPremium` to the agent ATA.

**Net:** the attacker round-trips USDC to themselves (cost ≈ 2× Solana fee ≈
$0.001) and collects `amountPaid + $0.001` from the pool. **Profit ≈
`amountPaid`** (the self-payment nets out; the refund is the pool's money). The
collusion buys "verified:true" — which (a) defeats any future control that
trusts the verified flag, and (b) is idempotent-keyed so it can't be replayed,
but **can be re-run with a fresh real payment each hour** to drain the reset cap
(A-4 with a verified veneer). Verified mode is **not** safer against a colluding
pair; it only stops a lone client from claiming a *stranger's* payment.

**File:line:** `payment-verify.ts:99-108` (proves transfer, not call outcome),
the file's own TODO at `payment-verify.ts:19-27` acknowledges it doesn't bind
the agent as source; `coverage.ts:205-221`.

---

### A-7 — Allowance-revoke griefing (free unverified events)

**Note this is a *pool-accounting* quirk, low severity, but it makes A-1 even
cheaper.** The allowance check (`coverage.ts:272-303`,
`packages/facilitator/src/lib/allowance.ts`) only confirms the agent *can* pay
the premium; it's a *read*, not an escrow. The premium is actually debited
on-chain by `settle_batch` (`settle_batch.rs:329-337`) much later. An attacker
who passes the allowance check at register time, then revokes the SPL delegate
before the batch lands, makes `settle_batch`'s premium-transfer fail. **Need to
verify** whether a failed premium transfer aborts the whole batch (poisoning
honest co-batched events) or just that event — `settle_batch.rs:329-337` is a
`transfer_*` that returns `?`, which propagates an `Err` and **reverts the
entire instruction**, i.e. the whole 3-event batch nacks and Pub/Sub redelivers
→ poison loop. **UNVERIFIED end-to-end** (didn't trace the nack/redelivery
interaction under a mid-batch SPL failure); flag for a dedicated test. If
confirmed, this is a cheap **DoS on the settler** independent of the drain.

**File:line:** `coverage.ts:272-303` (allowance is a read), `settle_batch.rs:329-337`
(premium debit is `?`-propagated, batch-fatal).

---

## 2. EXPOSURE QUANTIFICATION

Using the verified §0 params. "Drain" = pool USDC moved to attacker wallets.

| Scope | Formula | Default-param value |
|---|---|---|
| Max drain per breach claim, x402 unverified (A-2) | `min(amountClaimed + flat, cap_remaining)` | up to **$5.00** in one call (claim ≥ $5; cap clamps) |
| Max drain per hour, per pool (the binding limit) | `exposureCapPerHourLamports` | **$5.00 / hour** |
| Max drain per hour, across N sybil agents (A-3) | `exposureCapPerHourLamports` (shared) | **still $5.00 / hour** — sybils don't multiply it |
| Max drain per day (A-4 reset loop) | `cap × 24` | **$120 / day** |
| Max drain per year | `cap × 24 × 365` | **≈ $43,800 / yr** |
| Hard ceiling regardless of cap | pool `current_balance` | **drain the float to $0** (`settle_batch.rs:470-477`) |
| Attacker net per claim (x402) | `refund − premium − gas` | `+$amountClaimed` (premium refunded in payout; gas paid by settler) |
| Attacker cost to start | 1 keypair + 1 ATA + 1 premium allowance | **≈ $0.001 + recoverable rent** |
| Break-even | first settled breach | **immediate** |
| Gateway per-breach payout (A-5) | fixed `imputed + flat` | **$1.001**, shared-cap-bounded, no inflation |

**The headline number for the founder:** with defaults, the exposure is
**$5/hour → ~$120/day → pool-empty** of *subsidised* funds, claimable for free
by anyone with a keypair, on the x402 path, *today*, in `accept-and-monitor`.
The cap is the ONLY thing standing between the current design and unbounded
drain — and A-2 shows a single call empties the whole hour's cap.

**Inputs labelled by confidence:** all $ values **VERIFIED** in seeds + env.
The "$43,800/yr" assumes the pool is continuously refunded and the cap stays at
$5 — both **operational assumptions**, not code facts. The A-7 poison-loop
severity is **UNVERIFIED**.

---

## 3. MINIMUM CONTROLS (ranked by risk-reduced ÷ effort)

The design's premise — accept-and-monitor, zero friction, defer the oracle to
v2 — can be made *not worth gaming* without an oracle, IF you accept that the
goal is "bound and claw back," not "prevent." Ranked best-first.

### C-1 — Enforce the per-call `imputedCost` ceiling on the x402 path (TINY effort, kills A-2)
**Build:** one line. In `computeEconomics`/`computeCoverage`, clamp the
principal: `principal = min(amountPaid, pool.imputedCostLamports)`
(`economics.ts:95`). This is *already advertised* as the behavior
(`well-known.ts:37` calls `imputedCost` the "perCallRefundCeiling") — the code
just doesn't do it. **Risk reduced:** eliminates A-2 entirely; caps any single
x402 claim at $1.001 like the gateway. **Residual:** A-1/A-3/A-4 unchanged (still
$5/hr drainable in $1 chunks). **Effort:** ~1 line + 1 test. **Do this first,
unconditionally — it's a latent bug regardless of the broader design.**

### C-2 — Per-agent rolling refund cap, on-chain or in the settler (MEDIUM effort, blunts A-1/A-3/A-4)
**Build:** track `current_period_refunds` keyed by **agent**, not just endpoint.
Cheapest version: a settler-side rolling-window counter per `agentPubkey`
(reject/zero refunds over `X/hr/agent`) — but a settler-side cap is bypassable
if the settler is restarted/stateless, so the durable version is an on-chain
per-agent refund accumulator (a small PDA per `(pool, agent)` window). **Risk
reduced:** forces the attacker back to genuine sybil fan-out (A-3) to sustain
drain, which then trips C-3. **Residual:** sybils still defeat it alone — must be
paired with C-3. **Effort:** settler-side = small; on-chain PDA = a new account +
init + cap logic in `settle_batch` (`~`day of Rust + LiteSVM tests).

### C-3 — Breach-claim-rate anomaly vs network baseline (MEDIUM effort, the actual answer to sybils)
**Build:** the indexer already has per-agent counters
(`events.service.ts:221-243`) and a full call history. Compute a rolling
network-wide breach rate; flag/auto-pause agents (or the pool) whose breach
ratio exceeds `baseline + k·σ`. A real population of x402 calls breaches at a
few %; a verdict-forger breaches at ~100%. **This is the single highest-leverage
control** because it's the only one sybils can't trivially dodge (to look normal
they must emit ~95% honest *paid* calls, which costs them real money and
collapses their ROI). **Risk reduced:** turns the attack from "free" into
"must pay for cover traffic." **Residual:** a patient attacker who mixes real
calls can stay under the threshold for a slow bleed — bounded by C-1/C-2.
**Effort:** read-path analytics + an auto-pause hook into the existing
`/admin` pause (`update-config`/pause ops already exist per CLAUDE.md API list).

### C-4 — Post-hoc reconciliation + clawback (MEDIUM effort, makes A-6/A-1 recoverable)
**Build:** since refunds land on-chain with full provenance (agent ATA, callId,
`source:"pay.sh"`, `verified` flag — `coverage.ts:314-328`, indexer `Call`
rows), run an offline job that re-checks settled breach claims against any
out-of-band signal you *do* have (merchant logs if/when available, payment-tx
existence for "verified" claims, statistical outliers from C-3) and debits
flagged agents' future premiums or freezes their allowance. **Risk reduced:**
converts an irreversible drain into a recoverable one; raises attacker risk from
zero to "your gains can be reversed and your key blacklisted." **Residual:**
clawback needs the agent to keep using the system (a burn-and-walk sybil keeps
its $5). **Effort:** a batch job + a denylist the facilitator consults at
register (`coverage.ts` early-reject).

### C-5 — Cross-check client claim vs gateway ground truth where both exist (LOW marginal effort, narrow)
**Build:** for any agent that *also* uses the gateway, the proxy has authoritative
self-observed outcomes. Where a resource is reachable through both paths, sample
the client's x402 verdict against the gateway's classification of the same
upstream. **Risk reduced:** small — most x402 resources never transit the
gateway, so coverage is partial. **Residual:** large (path disjoint by design).
**Effort:** low but **low value**; do last or skip for MVP.

### C-6 — Stake / reputation bond (HIGH effort, strongest but heaviest)
**Build:** require agents to post a refundable stake; slash on confirmed-bad
claims (needs C-3/C-4 to define "bad"). **Risk reduced:** highest — makes sybils
capital-expensive. **Residual:** none structural, but it reintroduces the
friction accept-and-monitor was designed to remove. **Effort:** new on-chain
escrow + slashing + UX. **Defer to v2 with the oracle** — it's the same weight
class.

**Recommended MVP set: C-1 (now, it's a bug) + C-3 (the sybil answer) + C-2
(durable bound) + C-4 (recoverability).** That is the smallest set that makes
accept-and-monitor not worth gaming: per-call bounded (C-1), per-agent bounded
(C-2), sybils must buy cover traffic (C-3), and gains are clawback-able (C-4).

---

## 4. RESIDUAL MORAL HAZARD (what is STILL gameable with the MVP control set)

Lock the call from this evidence — these are the honest gaps that survive C-1..C-4:

1. **The pool still pays out on a *claim*, not on *proof*.** With no oracle, a
   breach is whatever the client (or a colluding merchant, A-6) says it is. C-3
   makes lying *statistically* expensive, not *impossible*. A patient attacker
   who keeps their breach rate near baseline by interleaving real paid calls
   extracts a slow, perpetual bleed bounded only by the cap and clawback lag.
   **This is irreducible without authoritative call-outcome evidence** — i.e.
   the deferred oracle / zkTLS / merchant-cosigned receipt. Accept-and-monitor
   is structurally "trust, then maybe reverse," never "verify."

2. **Verified mode does not bind the agent as the payer** (`payment-verify.ts:19-27`
   TODO). A colluding pair (A-6) gets a "verified:true" stamp that any control
   keying off `verified` will over-trust. Don't let `verified` gate a *higher*
   refund tier without also proving agent-was-source.

3. **The shared per-pool cap is a blunt instrument.** It bounds total bleed but
   also means an attacker at each hourly rollover can deny the cap to honest
   users (A-3 #3 / A-4 griefing). Per-agent caps (C-2) fix the drain but a
   sybil swarm can still race honest users to exhaust the *pool-level* cap each
   hour. Mitigation is operational (alerting + pool top-up cadence), not code.

4. **Clawback assumes a returning identity.** Burn-and-walk sybils keep their
   take. The economic discipline only works if the expected future value of an
   agent's relationship exceeds its one-shot drain — true for real users, false
   for throwaway keys. So the *floor* on attacker profit per fresh key is
   `min(cap_remaining, imputed+flat)` ≈ **$1–$5, free, irreversible**, forever.
   That is the number to design the float and alerting around.

5. **A-7 (allowance-revoke poison loop) is UNVERIFIED and, if real, is a DoS
   that none of C-1..C-6 address** — it attacks the settler's batch liveness,
   not the pool balance. Needs its own test + an escrow-at-register or
   per-event isolation fix (don't let one event's premium failure abort a batch).

---

## Source-of-truth index (lines this report stands on)

- x402 trusts client verdict, enum-check only: `packages/facilitator/src/routes/coverage.ts:186`
- verifyPayment skipped in unverified mode: `coverage.ts:162,222-224`
- refund = client `amountBaseUnits` + premium, **unclamped by imputedCost**: `coverage.ts:177-185,250-258` + `packages/wrap/src/economics.ts:91-96`
- per-call ceiling advertised but not enforced on x402: `packages/facilitator/src/routes/well-known.ts:37` vs absence in `economics.ts`
- only auth gate is an ed25519 sig (free identity): `packages/facilitator/src/middleware/verify-signature.ts:69-157`
- payment proof ≠ call-outcome proof: `packages/facilitator/src/lib/payment-verify.ts:99-108,19-27`
- exposure cap is per-ENDPOINT, rolling, lazy-reset: `settle_batch.rs:404-423`
- pool-balance is the hard ceiling: `settle_batch.rs:470-477`
- refund threaded verbatim to chain: `packages/settler/src/submitter/submitter.service.ts:319-324`
- gateway upstream from registry, not client (A-5 bound): `packages/market-proxy/src/routes/proxy.ts:31,152`
- gateway principal fixed = imputed (no inflation): `packages/wrap/src/classifier.ts:96-104`, `economics.ts:95`
- no per-agent cap anywhere (analytics map only): `packages/indexer/src/events/events.service.ts:221-243` (counter, not gate)
- economic defaults: `packages/db/seeds/pay-default-endpoint.ts:41-46`, `packages/facilitator/src/env.ts:29-55`
