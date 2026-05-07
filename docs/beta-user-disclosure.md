# Pact Network — Private Mainnet Beta Disclosure

You're reading this because we invited you into the Pact Network private
mainnet beta. We want you to walk in knowing what works, what's still
fragile, and what we're asking of you. This is not a marketing page.

## What this is

Pact Network insures your AI API calls. You route them through our proxy at
`api.pactnetwork.io` and pay a small premium per call. If a call fails its
SLA — too slow, 5xx from the upstream, or a network error — you get refunded
automatically, in real USDC, from the coverage pool. Every refund is a real
on-chain Solana transaction you can audit. Pact only earns when your call
lands successfully within SLA.

## What you get during the beta

- Insured access to 5 endpoints: Helius, Birdeye, Jupiter, Elfa, fal.ai.
  More slugs come online as we onboard them.
- Real refunds in real USDC on real failures, paid out within ~30 seconds
  of the call.
- On-chain auditability — every settlement has a Solana tx signature you
  can look up. Nothing about the refund logic is hidden in our backend.
- A dashboard at `app.pactnetwork.io` showing your insurable state — your
  prepaid USDC balance, the SPL Token Approval delegation status, and your
  per-call history with the breach/no-breach classification for each.

## What you should know about risk

We'd rather you be uncomfortable than surprised, so:

- **This is a private beta.** Roughly 10-30 users at launch. The traffic
  pattern we'll observe is small and skewed by who you are. Bugs that hide
  at low volume can show up later.
- **Coverage pools are capped.** Each endpoint starts with $200-$1,000 in
  its pool. The on-chain `exposureCapPerHourLamports` enforces a per-rolling-hour
  payout ceiling per pool. If a single hour of breaches drains a pool past
  that cap, refunds for that pool pause until we top it back up. Successful
  calls keep working; only refunds for breached calls in that pool pause.
- **Upgrade authority is on a hot wallet for the first 2-4 weeks.** We hold
  the program's upgrade-authority keypair on a laptop while we watch how
  load behaves on real mainnet. After we're convinced the program is stable,
  we rotate to a Squads multisig. Until then: **if our laptop is compromised
  in this window, an attacker could redeploy the program with malicious
  code.** We mitigate with offline backups, FileVault, and the
  `pause_protocol` kill switch (below). It's not zero risk. It's the deliberate
  trade-off we made to get to mainnet faster — we'll do better in the next
  phase.
- **The kill switch can stop everything in one tx.** If we see a critical
  bug, we flip `pause_protocol` and on-chain settlement halts for every
  endpoint. While paused, premiums keep being charged on agent ATAs because
  that part runs in the proxy off-chain, but on-chain settlement is blocked.
  That means refunds and pool credits don't land until we unpause. Your
  refund-pending state is preserved for the duration of the pause and
  settles automatically on resume.
- **This is V1.** There are bugs we haven't found yet. Don't park more USDC
  in your agent's ATA than you're comfortable losing in a worst-case bug.
  Top up small, top up often, withdraw when you don't need it.

## Refund policy

- A call that breaches SLA refunds **the principal plus the premium**.
  The principal is the imputed cost of the failed call, configured per
  endpoint. The premium is what you paid for that call. So a breached call
  is net-zero to you and a small loss to the pool.
- Pact only earns when a call succeeds within SLA. On a successful call,
  the premium splits: a configurable cut goes to the network treasury, a
  cut goes to the integrator who registered the endpoint, and the residual
  stays in the coverage pool to fund future refunds.
- Refunds settle on-chain within ~30 seconds of the call. The dashboard's
  per-call detail view shows the exact split for each settlement, including
  the tx signature.

## How to opt out / withdraw

There's no lock-up. You can leave at any time:

- Revoke the SPL Token Approval delegate to the settlement-authority with
  `spl-token revoke <your-USDC-ATA>`. After that, no further premium debits
  can happen from your wallet. Your remaining USDC stays where it is.
- Stop calling the proxy. The protocol stops earning from you the moment
  you stop generating calls.

That's it. There's nothing to unwind, no withdrawal queue, no notice period.

## What we ask of you

- **Use it for real workloads.** Pact only proves itself if it sees actual
  agent traffic patterns. Synthetic loads tell us nothing useful.
- **Tell us when something breaks.** The dashboard surfaces some failure
  modes (premium debited but no settlement, off-by-one accounting, stale
  pool balances). Other failure modes we won't see unless you tell us.
- **Don't share the proxy URL or program ID outside the beta cohort.**
  This is gated traffic. We're keeping volume small on purpose so we can
  watch it. If you want a teammate added, ask us.

## Contact

<!-- TODO: insert contact -->

## Legal

Nothing here is financial advice. Pact Network is beta software provided
as-is, with no warranties, express or implied. Coverage pool payouts are
constrained by what the on-chain program does — not by what we say in any
doc, including this one. The protocol code lives at
<https://github.com/pactnetwork/pact-monitor>. What the chain does is what's
true. If you find a discrepancy between this doc and the program's actual
behavior, the program wins.
