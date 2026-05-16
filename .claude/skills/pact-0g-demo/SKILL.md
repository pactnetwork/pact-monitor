---
name: pact-0g-demo
description: "Run the Pact-0G end-to-end demo on 0G mainnet. Walks through balance + endpoint + pool + pay --breach, captures the fresh settle tx hash, and emits paste-ready X-post copy for the 0G APAC Hackathon submission. Use when the user says \"run the demo\", \"demo pact-0g\", \"/pact-0g-demo\", \"show the agent flow\", or is recording the hackathon submission video."
argument-hint: "[full|quick|x-post-only|verify]"
allowed-tools: Bash(pnpm *) Bash(cast *) Bash(curl *) Read Edit Write Grep Glob
---

# Pact-0G demo runner — 0G APAC Hackathon

Pact-0G is on-chain reliability insurance for AI agent API calls on **0G Mainnet (Aristotle, chain 16661)**. This skill drives the agent-perspective demo against the deployed `PactCore` so you can record the submission video, refresh the on-chain proof, or generate the X-post copy.

**Live mainnet state (verified 2026-05-16):**
- PactCore: `0xc702c3f93f73847d93455f5bd8023329a8118b7f`
- Premium token (USDC.e): `0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E`
- Settler/deployer: `0xAD091D67886138b3a3330e2A56D33a2E06688Fc7`
- Agent: `0x8F6Cb2179d0185cF0E4Dd27b3EA51781E3FF77B2`
- Dashboard: https://pact-zerog-dashboard.vercel.app

## Modes

The user's argument decides what to run. Default is `full`.

| Mode | What you do |
|---|---|
| `full` (default) | Pre-flight env → run all four commands in order → capture tx → update X-post copy with fresh tx hash. ~3 minutes wall-clock. Right for video recording. |
| `quick` | Skip pre-flight, just `pact-0g pay --breach`, capture tx, print artifacts. ~30 seconds. Right when you've already verified env and just need another fresh settle. |
| `x-post-only` | Don't run anything on-chain. Take the most recent settle tx hash from the user (or read it from `.claude/skills/pact-0g-demo/last-settle.txt`) and print paste-ready X-post copy. |
| `verify` | Read-only — balances, endpoint, pool. No state-changing tx. Right when you want to confirm everything is wired up without burning gas. |

If the user types `/pact-0g-demo` with no arg, default to `full`. If they say "another fresh settle for the video," use `quick`. If they say "give me the X post," use `x-post-only`.

## Pre-flight (only on `full` and `verify`)

Before running the demo, verify the environment. Bail with a clear message if any check fails — do not try to autofix funding or wallet generation.

```bash
# 1. Working directory
cd samples/zerog-demo

# 2. Deps installed
[ -d node_modules ] || pnpm install --filter @pact-network/zerog-demo...

# 3. .env present with both wallet keys
test -f .env || { echo "MISSING .env — copy .env.example and fill SETTLER_PK + AGENT_PK"; exit 1; }
grep -q "^AGENT_PK=0x[a-fA-F0-9]\{64\}" .env || { echo "AGENT_PK missing or malformed in .env"; exit 1; }
grep -q "^SETTLER_PK=0x[a-fA-F0-9]\{64\}" .env || { echo "SETTLER_PK missing or malformed in .env"; exit 1; }

# 4. Wallets funded on Aristotle
AGENT_ADDR=$(grep "^AGENT_PK=" .env | sed 's/.*=//' | xargs -I {} cast wallet address {} 2>/dev/null)
SETTLER_ADDR=$(grep "^SETTLER_PK=" .env | sed 's/.*=//' | xargs -I {} cast wallet address {} 2>/dev/null)
USDC=0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E
RPC=https://evmrpc.0g.ai

echo "Agent:   $AGENT_ADDR"
cast balance --rpc-url $RPC $AGENT_ADDR     # need ≥ 0.001 $0G if approve unsigned, otherwise 0 ok
cast call --rpc-url $RPC $USDC "balanceOf(address)(uint256)" $AGENT_ADDR
echo "Settler: $SETTLER_ADDR"
cast balance --rpc-url $RPC $SETTLER_ADDR   # need ≥ 0.01 $0G for settleBatch gas
```

If the agent has zero USDC.e or zero allowance to PactCore, the `pay` command will fail. In that case stop and tell the user to either:
- Fund the agent with USDC.e via [XSwap](https://xswap.link/bridge?toChain=16661), or
- Run `pnpm pact-0g approve` themselves to set the allowance (one-time)

## Step-by-step (mode = `full`)

Run these in order, with a brief narration between each. **Do not batch into one Bash call** — the user needs to see each step's output land separately if they're screen-recording.

### Step 1 — agent state

```bash
pnpm pact-0g balance
```

Narrate: *"Agent wallet on 0G mainnet, holds USDC.e, has approved PactCore as a spender. That's the only prerequisite — no on-chain registration, no SDK install, no API key."*

### Step 2 — endpoint config

```bash
pnpm pact-0g endpoint
```

Narrate: *"The `demo-chat` endpoint is registered on `PactCore`. Premium is 0.01 USDC.e per call, the SLO is 5 seconds, and the exposure cap is 1 USDC.e of refunds per hour. These are on-chain config — the agent reads them, the protocol enforces them."*

### Step 3 — coverage pool

```bash
pnpm pact-0g pool
```

Narrate: *"This is the coverage pool — liquidity that pays out refunds when calls breach the SLO. Topped up by integrators, not by agents."*

### Step 4 — settle one insured call (THE MONEY SHOT)

```bash
pnpm pact-0g pay --breach
```

Capture the settle tx hash from the output (line starts with `[settle   ]`). Save it for the X-post.

Narrate: *"This is the whole product. The agent calls a Pact-insured endpoint. The call breaches the 5-second SLO. The protocol charges the premium, then automatically refunds the agent from the coverage pool. **Agent's net cost: zero.** No claim filing, no dispute resolution — refund settled on-chain, atomically with the premium debit."*

Then open the chainscan URL the CLI printed and let the user see the tx page for ~10 seconds.

### Step 5 — verify dashboard refresh

```bash
sleep 16   # dashboard revalidates every 15s
curl -sS https://pact-zerog-dashboard.vercel.app | grep -c "settled calls"
```

Then open https://pact-zerog-dashboard.vercel.app in the user's browser if they're recording. New row should appear within 15 seconds.

### Step 6 — write the fresh tx hash + emit X-post copy

Save the captured tx hash to a small file the skill can read on later runs:

```bash
echo "<TX_HASH>" > .claude/skills/pact-0g-demo/last-settle.txt
```

Then print the X-post copy with the fresh tx URL substituted in. See the **X-post template** section below.

## Mode = `quick`

Just step 4. Capture the tx, save to `last-settle.txt`, print the chainscan URL. Skip the narration, skip dashboard verify. Use for rapid retake during recording.

## Mode = `verify`

Steps 1–3 only. No state-changing tx, no gas burn. Use to sanity-check the env before recording.

## Mode = `x-post-only`

Don't touch the chain. Read the most recent tx hash from `.claude/skills/pact-0g-demo/last-settle.txt`. If the file is missing, ask the user to paste the tx hash. Print the X-post template with the tx URL substituted.

## X-post template

The user must post this on X with the four mandatory tags before the submission deadline. The Pact account is `@metalboyrick` (the founder's personal handle).

```
Just shipped Pact-0G to 0G mainnet for the @HackQuest_ 0G APAC Hackathon.

Insurance for AI agent API calls — agents pay a premium to 0G Compute, get refunded automatically when calls breach SLA. Settled on @0G_labs Chain, evidence on 0G Storage.

Live settled call: chainscan.0g.ai/tx/<TX_HASH>
Dashboard: pact-zerog-dashboard.vercel.app
Repo: github.com/pactnetwork/pact-monitor/tree/feat/pact-0g

#0GHackathon #BuildOn0G @0g_CN @0g_Eco
```

Substitute `<TX_HASH>` with the captured settle tx (use the short form `0xe690…3947`, full URL on its own line). Encourage the user to attach a screenshot of the dashboard row showing the breach refund.

## When things go wrong

- **`Agent allowance < premium`** — agent never ran `pact-0g approve`. Run `pnpm pact-0g approve` to fix. Costs ~0.001 $0G in gas.
- **`InvalidTimestamp()` revert** — local clock drifted past Aristotle's block.timestamp. The CLI's `cmdPay` already subtracts 5s from `block.timestamp`, but if it still trips, sleep 10s and retry.
- **`could not be found` after a tx submits** — 0G RPC propagation glitch. The CLI's manual poll loop handles this; if it surfaces anyway, query the tx directly: `cast tx <hash> --rpc-url https://evmrpc.0g.ai`.
- **Wallet balance shows 0 USDC.e but cast says it has some** — the CLI reads from the same RPC; if it disagrees, the RPC returned a stale block. Rerun.

## Submission form fields (paste-ready)

Once the demo lands a fresh tx and the X-post goes up, fill the HackQuest submission form. The single source of truth for every field is `HACKATHON-SUBMISSION.md` at the repo root, mirrored in the local grant-applications platform at `dev/docs/grant-applications/index.html` (entry id: `0g-apac-hackathon`) where each field has a one-click Copy button.

Key fields:

| Field | Value |
|---|---|
| Project repo | https://github.com/pactnetwork/pact-monitor/tree/feat/pact-0g |
| 0G mainnet contract | `0xc702c3f93f73847d93455f5bd8023329a8118b7f` |
| 0G Explorer link (on-chain activity) | fresh tx URL from the last `pact-0g pay --breach` run, OR the original `0x218aa729...` if you didn't run a fresh one |
| Frontend demo URL | https://pact-zerog-dashboard.vercel.app |
| Submission tag (frozen) | https://github.com/pactnetwork/pact-monitor/releases/tag/0g-apac-hackathon-2026-05-16 |
| Demo video URL | (TODO — record and upload, then paste here) |
| Contact email | rick@quantum3labs.com |
| Contact Telegram | t.me/metalboyrick |
