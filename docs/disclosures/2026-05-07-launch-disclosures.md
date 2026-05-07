# Pact Network — launch disclosures (2026-05-07)

This file holds all three user-facing disclosure surfaces for `app.pactnetwork.io`
in one place so reviewers can read them without deploying. The canonical
copies live at:

- **Modal + banner** — embedded in the dashboard layout (TBD: component path
  once `app.pactnetwork.io` is wired up).
- **Full /risks page** — `packages/market-dashboard/content/risks.mdx`.

If any of the three disagrees with the MDX page, the MDX page wins.

---

## 1. First-connect modal (~110 words)

**Title:** Before you connect

Pact Network is parametric, on-chain insurance for AI API calls. It is **not**
regulated insurance. There is no insurer, no regulator, and no policy contract
beyond the protocol code. The Solana program is unaudited and currently
controlled by a single hot upgrade key — multisig rotation is in flight.

Coverage pools are finite. If many agents breach SLA at once, refunds can be
delayed or capped per pool. Premiums on successful calls are not refundable.
You self-custody your USDC and can revoke the approval at any time with
`spl-token revoke`.

Use this only with funds you can afford to lose.

[ ] I've read the [full risks page](/risks) and accept these terms.

**[ Connect wallet ]** (disabled until checkbox is checked)

---

## 2. Persistent banner (~25 words)

> **Beta — unaudited, finite coverage pools, hot-key upgrade authority.**
> Pact is parametric, not regulated insurance. [Read the risks](/risks) before
> you fund.

Banner is sticky on the dashboard for the duration of the beta. It dismisses
per-session (not permanently) so users see it on every fresh load until we
exit beta.

---

## 3. Full /risks page

The full long-form page lives at
`packages/market-dashboard/content/risks.mdx` and renders at `/risks` on
`app.pactnetwork.io`. It covers, in order:

1. This is not regulated insurance.
2. No KYC, no regulatory protection, jurisdictional restrictions.
3. Smart contract risk (program ID, hot upgrade key, no third-party audit).
4. Coverage pool exhaustion (per-endpoint pools, hourly exposure caps).
5. Settlement timing is not guaranteed (`x-pact-settlement-pending` header).
6. Network and upstream API risks (we don't insure Solana or upstream outages).
7. Premiums are not refundable on success.
8. Self-custody and how to leave (`spl-token revoke`).
9. No customer support SLA.

Plus a "what we don't promise" section that explicitly disclaims "trustless,"
"secure," and "guaranteed."

The full text is in the MDX file. Read it there — duplicating it here just
creates drift.

---

## Open decisions for Rick

The MDX page contains two `TODO(rick)` markers. Until they're resolved we
shouldn't ship the page publicly:

1. **Restricted-jurisdictions list (Section 2).** At minimum needs a call on:
   - US persons — yes/no? (Default recommendation: restrict, given parametric
     insurance regulation in most US states and likely SEC posture on
     token-denominated coverage.)
   - OFAC sanctioned countries (Cuba, Iran, North Korea, Syria, Crimea/DNR/LNR
     regions of Ukraine) — almost certainly yes, restrict.
   - Other licensed-insurance-required jurisdictions (UK FCA, EU EIOPA member
     states, Singapore MAS, etc.) — needs a call.
   - Geo-block enforcement: do we just disclaim, or do we add IP geofencing
     at the Cloud Armor / dashboard edge?

2. **Age gate.** Not currently in the disclosure. Most US-state consumer
   financial-product law assumes 18+. Decide whether to add a self-attest age
   checkbox or skip.

3. **Security contact (Section 9 / Contact).** Need a real email and PGP key
   fingerprint before the public launch. `security@pactnetwork.io` would be
   the obvious choice but it doesn't exist yet.

4. **Repository URL.** The MDX currently links to
   `github.com/solder-build/pact-monitor`. If we plan to migrate to
   `github.com/pactnetwork/pact-monitor` before public launch, update the
   link there too. (The original task brief referenced `pactnetwork/pact-monitor`
   as the canonical org, but the repo's actual remote is `solder-build`. Pick
   one and align both.)

5. **Banner dismissal behavior.** Currently spec'd as per-session.
   Alternative: persistent dismiss with re-prompt on protocol changes (audit
   completion, upgrade-authority rotation, new endpoint onboarding). Engineering
   call.

None of these are blocking the PR review — they're blocking the merge to a
public dashboard build.
