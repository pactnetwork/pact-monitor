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

Pact Network is a parametric, on-chain coverage protocol for AI API calls.
It is **not** regulated insurance. There is no insurer, no regulator, and
no policy contract beyond the protocol code. The Solana program is
unaudited and currently controlled by a single hot upgrade key — multisig
rotation is in flight.

Coverage pools are finite. If many agents breach SLA at once, refunds can
be delayed or capped per pool. Premiums on successful calls are not
refundable. You self-custody your USDC and can revoke the approval at any
time with `spl-token revoke`.

Use this only with funds you can afford to lose.

[ ] I am 18 or older, am not a US person or located in an OFAC-sanctioned
jurisdiction, and I've read the [full risks page](/risks) and accept these
terms.

**[ Connect wallet ]** (disabled until checkbox is checked)

---

## 2. Persistent banner (~22 words)

> **Beta — unaudited, finite coverage pools, hot-key upgrade authority.**
> Pact is a parametric protocol, not regulated insurance.
> [Read the risks](/risks) before you fund.

Banner is sticky on the dashboard for the duration of the beta. It
dismisses per-session — it reappears on every new browsing session until
we exit beta.

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
6. Network and upstream API risks (the protocol does not cover Solana or upstream outages).
7. Premiums are not refundable on success.
8. Self-custody and how to leave (`spl-token revoke`).
9. No customer support SLA.

Plus a "what we don't promise" section that explicitly disclaims "trustless,"
"secure," and "guaranteed."

The full text is in the MDX file. Read it there — duplicating it here just
creates drift.

---

## Decisions locked for launch

These were the open items in earlier drafts. All are resolved:

1. **Restricted users (Section 2).** US persons and OFAC-sanctioned
   jurisdictions (Cuba, Iran, North Korea, Syria, and the Crimea, Donetsk,
   and Luhansk regions of Ukraine) are excluded. We are not adding FCA /
   EIOPA / MAS-style licensed-jurisdiction restrictions at launch.
   Enforcement is disclaimer-only — attestation in the connect modal, no
   Cloud Armor IP geofence. We can add edge geo controls later if
   regulators surface concerns.

2. **Age gate.** Self-attest 18+ is folded into the single connect-modal
   checkbox alongside the OFAC / US-person attestation and the risks
   acknowledgement.

3. **Security contact.** `security@pactnetwork.io`. PGP key forthcoming —
   unencrypted reports are accepted at that address until further notice.

4. **Repository URL.** Canonical is
   `https://github.com/pactnetwork/pact-monitor`. The `solder-build` remote
   is the build-fork push target only and is not user-facing. All
   disclosure surfaces link to `pactnetwork/pact-monitor`.

5. **Banner dismissal.** Per-session. The banner reappears on every new
   browsing session until we exit beta. No persistent-with-trigger logic.
