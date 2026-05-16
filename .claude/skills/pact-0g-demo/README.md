# pact-0g-demo — Claude Code skill

Project-local skill for the 0G APAC Hackathon submission demo. Auto-discovered by Claude Code when this directory exists at `.claude/skills/pact-0g-demo/`.

## What it does

Walks Claude through the agent-perspective demo on 0G mainnet:

1. **Pre-flight** — deps installed, `.env` complete, both wallets funded
2. **Read commands** — `pact-0g balance`, `endpoint`, `pool` to set the stage
3. **The money shot** — `pact-0g pay --breach` settles an insured call on-chain; agent gets refunded
4. **Dashboard verify** — wait for ISR revalidation, confirm new row appears
5. **X-post** — emit paste-ready tweet with the fresh tx URL

## Invoke

```
/pact-0g-demo                 # full flow, ~3 min, for video recording
/pact-0g-demo quick           # just the settle + X-post, ~30 s, for retake
/pact-0g-demo verify          # read-only sanity check, no tx
/pact-0g-demo x-post-only     # print the X-post using the last captured tx
```

Or say it in natural language: "run the pact-0g demo", "show me the agent flow", "another fresh settle for the video".

## Prereqs

- `pnpm install` has run in `samples/zerog-demo/`
- `samples/zerog-demo/.env` has `SETTLER_PK`, `AGENT_PK`, `PACT_CORE_ADDRESS`, `USDC_ADDRESS`
- Both wallets funded on Aristotle (see HACKATHON-SUBMISSION.md for amounts)
- `foundry` installed (the skill uses `cast` for balance checks)

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | The skill instructions Claude reads |
| `README.md` | This file — for humans |
| `last-settle.txt` | (generated) most recent settle tx hash, used by `x-post-only` mode |
