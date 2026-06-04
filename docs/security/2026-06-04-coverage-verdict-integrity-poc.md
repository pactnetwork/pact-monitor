# Coverage verdict-integrity — PoC (agent-tasks#10)

**Status:** PoC for review. Default behaviour unchanged (`COVERAGE_INTEGRITY_MODE=trust`).

> **Scope of this PR.** This is the shippable core: the `trust` (default, zero
> behaviour change) and `verified-only` modes. The `merchant-attested` mode
> (a merchant-signed outcome receipt whose signed HTTP status overrides the
> client verdict) ships in the **stacked follow-up PR** on top of this one.

## The bug

`POST /v1/coverage/register` pays pool-funded refunds off a **client-supplied SLA verdict**.
`pact pay` classifies the call outcome locally on the agent's machine, then POSTs
`{verdict, payment receipt, ed25519 signature}`. The facilitator only checks the verdict is a
valid enum member (`isKnownVerdict`, `coverage.ts:186`) — never that it is **true** — then maps it
to a covered outcome and refund (`coverage.ts:249`, `verdictToOutcome` → `computeCoverage`).

A malicious agent submits `verdict:"server_error"` for a call that actually **succeeded** →
refund from the pool → indemnity fraud / pool drain. Same class as SOL-01 (trust in caller-supplied
data on the money path).

Today the damage is **bounded, not prevented**: ed25519 agent envelope, on-chain payment
verification in "verified mode", on-chain per-pool hourly exposure cap + ~$1/call imputed ceiling,
refund capped at `min(amountPaid, imputed)`. The "unverified/degrade" mode skips even the payment
check.

## What the gateway does right (the contrast)

The gateway (`wrap` inside `market-proxy`) classifies **server-side** from the real upstream
`Response` the proxy itself observed — the client can't forge it. The x402 facilitator is
structurally weaker because the breach signal originates client-side and the facilitator never sees
the HTTP exchange.

## Research outcome (two rteam specialists, both read the real code)

- **Option 2 full (merchant-signed FAILURE receipt): structurally impossible.** A failure receipt
  needs the failing merchant to co-sign its own failure; `network_error` (merchant unreachable) has
  no signer, hard 5xx has a downed signer. It can't cover the breaches users actually insure.
- **Shippable core (both agents):** drop the unverified/degrade payout path + ship a `pay` build
  that logs the settle tx sig so x402 goes *verified by default*; harden on-chain caps as the
  economic backstop. **This is what `verified-only` implements.**
- The opt-in merchant-cosigned receipt (`merchant-attested`) is the only *shippable* Option-1 form
  and ships in the **stacked follow-up PR**.

## This PR

One env flag — `COVERAGE_INTEGRITY_MODE` — selects the strategy. All logic is in
`src/lib/integrity.ts` (pure, unit-tested); the route wires it in between the payment-verify and
coverage-math steps.

| Mode | Refund rule | Outcome source | Notes |
|---|---|---|---|
| `trust` (default) | covered breach → refund | client verdict | current behaviour, unchanged |
| `verified-only` | covered breach **and** on-chain-verified payment | client verdict | Option 2 shippable core; drops unverified payouts |

### Honest limitations (encoded as tests)

- `verified-only` does **not** fix the verdict-trust bug — a verified agent can still lie. It
  shrinks the blast radius to "agent who really paid, lying about a real call, capped at $1/call".

## Recommendation

1. **Now:** ship `verified-only` + a `pay` build that exposes the settle tx sig (`payee` is already
   recoverable at `pay-classifier.ts:110`; only `paymentSignature` is missing). Add per-payee
   exposure caps + breach-rate anomaly monitoring.
2. **Opt-in tier:** `merchant-attested` for merchants willing to sign (the stacked follow-up PR;
   curated pools could mandate it at onboarding).
3. **Roadmap:** zkTLS web-proof to kill client-verdict trust entirely.

## Files

- `src/lib/integrity.ts` — modes + `decideIntegrity`.
- `src/routes/coverage.ts` — integrity gate wired in (step 7a).
- `src/env.ts` / `src/lib/context.ts` — `COVERAGE_INTEGRITY_MODE` flag.
- `test/integrity.test.ts` — unit tests for the pure functions.
- `test/register.test.ts` — end-to-end tests for `trust` + `verified-only`.
