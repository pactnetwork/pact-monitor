# RECOMMENDATION — SLA-verdict trust (agent-tasks#10)

> For Richard, to lock the call from evidence. Companions, all at repo root:
> `MECHANISM_MAP.md` (how it works today), `VERDICT_SOURCE_DESIGN.md` (the
> abstraction), `SECURITY_REDTEAM_VERDICT.md` (the attacks + numbers). This doc
> is the synthesis + the decisions you need to make. Every claim cites code.

## The one-paragraph answer

"How does Pact decide a breach occurred?" already has two answers in the code,
at opposite ends of trust. **On the gateway (`pact <url>`), Pact decides it —
the proxy makes the upstream fetch, times it, and classifies the real response;
the client cannot supply the verdict** (`wrapFetch.ts:147,155`,
`classifier.ts:62`). That is zero-trust and shippable as-is. **On the off-gateway
x402 path (`pact pay`), the client decides it — the facilitator trusts the
client's `verdict` string verbatim** (`coverage.ts:186,250`); `verifyPayment`
proves the payment happened, never that the call failed
(`payment-verify.ts:1-9`). That second path is the moral-hazard hole. The
recommended direction — drop merchant receipts, default to accept-and-monitor,
use Pact's own observation wherever Pact is in the path, defer a real oracle to
v2 — is **sound**, and this spike makes it explicit, provable, and bounded. But
it does not eliminate the residual risk: without an oracle, the off-gateway pool
pays on a *claim*, not a *proof*. The controls make lying expensive and
reversible, never impossible.

## What shipped in this spike (all tests green)

1. **`VerdictSource` provenance, stamped + provable.** New type
   `"pact_observed" | "client_attested" | "oracle"` (`wrap/src/types.ts`),
   carried as an optional field on `SettlementEvent` and a field on
   `PaySettlementEvent`. Gateway stamps `pact_observed` at `wrapFetch.ts:170`;
   facilitator stamps `client_attested` at `coverage.ts:319`. Now the settler,
   indexer, and chain can tell a self-observed refund from a claimed one — today
   they cannot. Backward-compatible (optional field, like `network?`); verified
   that settler/indexer/market-proxy all build clean and ignore it.
   Tests prove the gateway verdict is derived from the response and is immune to
   client input (`wrapFetch.test.ts` "verdict provenance").

2. **🔴 C-1: the advertised "$1/call" refund ceiling is now actually enforced.**
   This is the highest-leverage fix and it is **independent of the whole
   design**. `env.ts:33-42` documents `imputedCost` as a per-call cap
   ("...capped at this value so a single large claim can't drain the pool") and
   `/.well-known/pay-coverage` advertises it — **but the code never applied it**:
   the refund principal was the raw client-supplied `amountBaseUnits`, validated
   only `> 0` (`coverage.ts:183-185`, `economics.ts:95`). One `register` call
   with `amountBaseUnits:"5000000"` drained the entire $5 hourly pool in a single
   shot (red-team A-2). `computeCoverage` now clamps
   `principal = min(amountPaid, imputedCost)` (`lib/coverage.ts`). This makes the
   worst-case x402 claim equal to the gateway's fixed payout.

3. **Accept-and-monitor abuse controls, designed + feature-flagged OFF.** Pure,
   fully-tested decision function `evaluateClientAttestation(...)` →
   `allow | throttle(reason)` (`lib/attestation-controls.ts`) implementing the
   per-agent rolling refund cap + breach-claim-rate anomaly vs network baseline.
   Wired into the facilitator behind `PACT_VERDICT_ATTESTATION_GATE`
   (`off | log_only | enforce`, **default off** = today's zero-friction
   behavior, no DB reads). `enforce` declines an anomalous claim (downgrade to
   uncovered, no settlement event); `log_only` is shadow mode. Fails **open** on
   a stats-read error — never blocks a legit refund on a DB blip; the on-chain
   hourly cap stays the hard backstop.

4. **v2 oracle seam.** Adding an `"oracle"` verdict source later needs a new
   *producer* only — same event, same `computeEconomics`, same topic, same
   on-chain executor. No settler/indexer/chain rework. (`VERDICT_SOURCE_DESIGN.md` §4.)

Tests: wrap 75 ✓ · facilitator 116 ✓ · settler 138 ✓ · indexer + market-proxy build clean.

## The decisions you need to lock

1. **Ratify the C-1 cap (recommended: YES).** An existing test deliberately
   asserted the refund was *not* capped ("exposure cap is on-chain",
   `coverage-math.test.ts`), which directly contradicts the env doc and the
   advertised $1/call ceiling. I flipped it to assert the cap and cited the
   contradiction in-test. If you actually want uncapped principal refunds, that
   is the lever to pull — but then stop advertising a per-call ceiling, because
   a single claim can still eat a whole hour's pool. **My recommendation: keep
   the cap.** It costs nothing and closes the worst drain.

2. **Adopt the verdict-source direction (recommended: YES).** Gateway =
   authoritative (already true, now provable). Off-gateway = accept-and-monitor
   (now stamped + bounded). Drop merchant receipts (the prior PoC #253/#254 was
   never merged; this supersedes it). No reason found to hold this.

3. **When to turn the gate on.** Leave `PACT_VERDICT_ATTESTATION_GATE=off` for
   the MVP — the on-chain hourly cap + C-1 already bound the loss to **~$5/hour /
   ~$120/day per pool** (red-team §quantification). Flip to `log_only` once
   pay.sh refund volume is non-trivial (collect the anomaly signal for free),
   then `enforce` only if observed forgery approaches the cap. The thresholds in
   `attestation-controls.ts` are conservative spike defaults; tune from the
   `log_only` data before enforcing.

4. **Accept the residual moral hazard for the MVP (honest take: YES, with eyes
   open).** See below.

## Residual moral hazard — the honest part

Even with C-1 + both controls enabled, **the off-gateway pool still pays on a
claim, not a proof.** Concretely (red-team, verified):

- **Floor on attacker profit: $1–$5, free, irreversible, per fresh throwaway
  key.** The per-agent cap and anomaly check raise the *cost* of looking normal
  (a forger must emit mostly real, paid, non-breach calls to keep their breach
  rate near baseline — that costs real money), but a low-and-slow sybil under
  the radar still extracts up to the per-endpoint hourly cap.
- **The on-chain hourly exposure cap is the only hard real-time bound.** The
  off-chain controls read *settled* history, so they lag in-flight claims; they
  add per-agent + anomaly signal, not a real-time ceiling. Keep the on-chain cap
  tight on the subsidised launch pool — it is the backstop, by design.
- **The gateway path is materially safer** and should be the steered-to default:
  fixed $1.001 payout, true self-observation, no client-supplied principal. The
  only residual there is farming *genuine* provider 5xx / latency breaches
  (`$1.00`/breach, cap-bounded) — Pact really did observe a real failure, so
  that is arguably correct behavior, not fraud.
- **Do not let `verified` gate a higher refund tier.** `verifyPayment` proves a
  payment, and does not even bind the agent as the *payer*
  (`payment-verify.ts:19-27` TODO) — a colluding client+merchant can produce
  `verified:true` and self-pay. `verified` ≠ trustworthy outcome.

**Bottom line:** ship the gateway self-attestation + C-1 + provenance now; they
are zero-trust, shippable, and close the unbounded drain. Run accept-and-monitor
with the gate off, on-chain cap tight, until refund volume justifies turning it
on. A real fix for the residual (binding the off-gateway *outcome* to proof)
needs the v2 oracle — the seam is in place; build it when fraud is worth gaming,
not before.
