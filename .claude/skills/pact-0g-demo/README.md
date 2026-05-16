# pact-0g-demo — Claude Code skill

Project-local skill that teaches Claude how and when to invoke the `pact-0g` CLI. Auto-discovered by Claude Code when this directory exists at `.claude/skills/pact-0g-demo/`.

## What's inside

`SKILL.md` documents:
- What each `pact-0g` subcommand does (`balance`, `approve`, `endpoint`, `pool`, `pay`)
- When to use each one
- Common flows (first-time setup, read-only verify, single insured call)
- Pre-conditions and how to recover when they're missing

That's it. The skill is a reference, not a recording orchestrator.

## Prereqs

- `pnpm install` has run inside `samples/zerog-demo/`
- `samples/zerog-demo/.env` has `SETTLER_PK`, `AGENT_PK`, `PACT_CORE_ADDRESS`, `USDC_ADDRESS`
- Both wallets funded on Aristotle (see HACKATHON-SUBMISSION.md for amounts)
