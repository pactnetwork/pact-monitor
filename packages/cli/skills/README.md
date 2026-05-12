# pact-cli Claude Code skills

Drop-in [Claude Code](https://claude.com/claude-code) skills for working with `pact`.

## `pact-pay/` — route pay.sh calls through Pact Network

Makes a Claude Code agent use `pact pay <tool> ...` instead of calling the
`pay` binary (solana-foundation/pay) directly, for any paid HTTP call — adding
a Pact coverage verdict (and, for Pact-onboarded providers, on-chain SLA
refunds via `pact <url>`).

**Install (user-global — applies in every project on this machine):**

```bash
mkdir -p ~/.claude/skills/pact-pay
curl -fsSL https://raw.githubusercontent.com/pactnetwork/pact-monitor/main/packages/cli/skills/pact-pay/SKILL.md \
  -o ~/.claude/skills/pact-pay/SKILL.md
```

(or copy it into a single project at `./.claude/skills/pact-pay/SKILL.md`.)

**Prereqs:** `npm i -g @q3labs/pact-cli` · the `pay` binary (solana-foundation/pay)
· `export PACT_MAINNET_ENABLED=1` for the mainnet path, or use `pact pay curl --sandbox …`
to try it with fake money.

> Note: the repo is currently private — until it's public, `curl`ing the raw
> URL above will 404; copy the file contents directly instead.

## `pact-demo/` — use the "dummy services" / demo Pact coverage

Drives the live flaky demo upstream at `https://dummy.pactnetwork.io` to
exercise or screen-record the Pact coverage flow (`?fail` / `?status` /
`?latency` / `?x402` toggles; `pact pay --sandbox` walkthrough; the gateway-path
on-chain demo). There's also a `bash packages/dummy-upstream/demo.sh` driver.

**Install:** copy `pact-demo/SKILL.md` to `~/.claude/skills/pact-demo/SKILL.md`.

## See also

`pact init` installs the broader `pact` skill (the insured-gateway flow for the
onboarded providers) into `.claude/skills/pact/SKILL.md` and a snippet into your
`CLAUDE.md`/`AGENTS.md`.
