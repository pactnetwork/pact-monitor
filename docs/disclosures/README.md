# Pact Network — user-facing disclosures

This directory holds all user-facing legal and risk-disclosure copy for
Pact Network. Source of truth for "what does the dashboard show users
before they connect a wallet."

## Index

| File | Purpose | Surfaces |
|---|---|---|
| [`2026-05-07-launch-disclosures.md`](./2026-05-07-launch-disclosures.md) | Mainnet launch disclosure pack — first-connect modal, persistent banner, summary of `/risks` page. Open decisions for Rick at the bottom. | `app.pactnetwork.io` modal, banner, and `/risks` |
| [`../beta-user-disclosure.md`](../beta-user-disclosure.md) | Private beta disclosure handed to invited beta users (pre-mainnet). Tone reference for the public launch copy. | Email/Notion handed to invitees |

## Canonical rendered copies

Each disclosure has a "lives in the dashboard" copy and a "review-friendly
markdown" copy. When they disagree, the dashboard copy wins because that's
what users actually see.

| Surface | Canonical location |
|---|---|
| First-connect modal | TBD — dashboard component (not yet wired up) |
| Persistent banner | TBD — dashboard layout |
| Full `/risks` page | [`packages/market-dashboard/content/risks.mdx`](../../packages/market-dashboard/content/risks.mdx) |

## How to update

1. Edit the `.mdx` page first (it's the user-visible source of truth).
2. Mirror any material changes into the dated review file in this directory
   so reviewers and counsel can diff against prior versions.
3. Bump the `updated:` frontmatter date in the MDX.
4. Do not delete prior dated review files — they are the historical record
   of what users saw on a given date. Append; don't rewrite.

## Conventions

- Founder-written voice. No "Whereas," "shall," or other legal-firm
  boilerplate. We use "we" and "you," contractions are fine, varied
  sentence length.
- We say what we **don't** do as plainly as what we do.
- We do not call Pact "trustless," "secure," or "guaranteed." The protocol
  code defines the behavior; we describe it accurately and we name the
  residual risk.
- TODOs that block public publication are tagged `<!-- TODO(rick): ... -->`
  in the MDX so they show up in a grep.
