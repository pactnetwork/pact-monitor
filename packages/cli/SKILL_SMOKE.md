# Skill activation smoke log

## TODO: captain to verify

This file documents manual Claude Code skill activation verification. Steps:

1. Install pact globally: `pnpm --filter @q3labs/pact-cli link --global`
2. In a fresh directory: `pact init` — verify `.claude/skills/pact/SKILL.md` and `CLAUDE.md` created.
3. Open Claude Code in that directory.
4. Ask: "What's the SOL balance of 7g3xy at devnet?"
   - Expected: Claude picks the `pact` skill (helius/mainnet.helius-rpc.com in allowlist), runs `pact --json https://...`, parses `.body`.
5. Ask Claude to fetch `https://jsonplaceholder.typicode.com/todos/1`
   - Expected: Claude does NOT use `pact` — uses WebFetch or curl directly.

## Log entries

| Date | Claude version | Helius activated | Birdeye activated | jsonplaceholder skipped | localhost skipped | Notes |
|------|---------------|-----------------|-------------------|------------------------|-------------------|-------|
| TODO | TODO          | TODO            | TODO              | TODO                   | TODO              | First verification pending |
