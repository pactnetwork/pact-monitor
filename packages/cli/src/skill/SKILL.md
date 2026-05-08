---
name: pact
version: 0.1.0
description: Insured paid API calls for AI agents on Solana. Use INSTEAD of curl/fetch/Bash when calling these provider hostnames: api.helius.xyz, mainnet.helius-rpc.com, public-api.birdeye.so, quote-api.jup.ag, lite-api.jup.ag, api.elfa.ai, fal.run. Routes through market.pactnetwork.io for premium-billed insurance with auto-refund on upstream failure. v0.1.0 is MAINNET-ONLY and requires PACT_MAINNET_ENABLED=1. Use `pact pay curl <url>` to wrap any 402-gated x402 or MPP endpoint. Do NOT use for: localhost, your own server, free public APIs (jsonplaceholder, public RPCs without quotas), GET-by-static-CDN fetches.
---

# Pact — insured API calls for AI agents

> **v0.1.0 — Mainnet only.** Real USDC. Closed beta gate: `PACT_MAINNET_ENABLED=1` must be set in the environment before any command runs.

You have access to `pact`, a CLI that wraps API calls and insures them automatically. Calls go through Pact Network's gateway at `market.pactnetwork.io`; if the upstream fails an SLA, your agent's USDC is auto-refunded out of the per-endpoint coverage pool.

## Quick start

```bash
# 1. Install (Homebrew once available; for now grab the prebuilt binary)
curl -sSL https://pact.network/install.sh | sh

# 2. Set the mainnet gate + project name
export PACT_MAINNET_ENABLED=1
export PACT_PROJECT=my-agent

# 3. Initialize this project's skill + claude.md snippet
pact init

# 4. Grant a USDC allowance to the SettlementAuthority delegate
pact approve 5      # cap settlement debits at $5 USDC

# 5. Make insured calls
pact --json https://api.helius.xyz/v0/addresses/<addr>/balances
```

`pact init` writes the skill into `.claude/skills/pact/SKILL.md` and appends a snippet to `CLAUDE.md` / `AGENTS.md` so Claude Code picks it up automatically.

## Status table — every closed value, exit code, meaning, remediation

ALWAYS pass `--json`. Parse `.status` first; never grep stdout.

| status                  | exit | meaning                                                            | remediation                                                                                          |
|-------------------------|------|--------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `ok`                    | 0    | call succeeded; use `.body`                                        | proceed                                                                                              |
| `client_error`          | 0    | request was malformed or upstream returned 4xx                     | surface to user; do not retry                                                                        |
| `server_error`          | 0    | upstream returned 5xx; refund auto-issued                          | retry once if idempotent                                                                             |
| `needs_funding`         | 10   | USDC ATA balance below estimated premium OR no allowance granted   | `pact approve <usdc>` if policy cap allows; else surface deposit URL from `.body.deposit_url`        |
| `auto_deposit_capped`   | 11   | self-funding cap exhausted                                         | raise `per_deposit_max_usdc` / `session_total_max_usdc` in `~/.config/pact/<project>/policy.yaml` or wait for session reset |
| `endpoint_paused`       | 12   | per-endpoint kill switch active                                    | pick another provider or wait                                                                        |
| `no_provider`           | 20   | URL hostname is not a registered insured endpoint                  | use `--raw` for an uninsured call, or surface to user                                                |
| `discovery_unreachable` | 21   | gateway is down or unreachable                                     | surface and stop; do not loop                                                                        |
| `signature_rejected`    | 30   | clock skew; signed request rejected by gateway                     | tell user to sync NTP (`sudo sntp -sS time.apple.com`)                                               |
| `payment_failed`        | 31   | `pact pay` reached a 402 challenge but the retry was rejected      | inspect `.body.scheme` (`x402`/`mpp`) + `.body.reason`; verify the upstream is Pact-aware            |
| `x402_payment_made`     | 0    | `pact pay --json` succeeded via x402 retry                         | response body in `.body.response_body`, wrapped tool exit in `.body.tool_exit_code`                  |
| `mpp_payment_made`      | 0    | `pact pay --json` succeeded via MPP credential retry               | same shape as `x402_payment_made`                                                                    |
| `needs_project_name`    | 40   | could not infer project from cwd / env                             | pass `--project <name>` or set `PACT_PROJECT`                                                        |
| `cli_internal_error`    | 99   | unexpected throw (likely a bug)                                    | report; the error is in `.body.error`                                                                |

> Exit codes 0 for `ok`/`client_error`/`server_error` are intentional: every shell-exit reflects whether `pact` itself ran cleanly, not whether the upstream returned data. Use `.status` to branch.

## Commands — one-line summary + JSON envelope shape

Every command returns the same envelope: `{ status, body, meta? }`.

| command                              | what it does                                                       | body keys (on `ok`)                                                                                              |
|--------------------------------------|--------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| `pact <url>`                         | insured GET/POST through the gateway                               | upstream JSON; `meta.slug`, `meta.call_id`, `meta.latency_ms`, `meta.premium_usdc`, `meta.tx_signature`           |
| `pact balance --json`                | wallet pubkey + ATA balance + granted allowance                    | `wallet`, `ata`, `ata_balance_usdc`, `allowance_usdc`, `eligible`                                                |
| `pact approve <usdc> --json`         | grant SPL Token allowance to SettlementAuthority                   | `tx_signature`, `allowance_usdc`, `confirmation_pending`                                                          |
| `pact revoke --json`                 | clear the allowance                                                | `tx_signature`, `confirmation_pending`                                                                            |
| `pact agents show --json [pubkey]`   | recent calls + refunds for this agent                              | upstream agent state from indexer                                                                                |
| `pact agents watch`                  | SSE stream of live events (line-delimited JSON)                    | one event per line                                                                                                |
| `pact pay curl [args] [--json]`      | wrap a CLI tool through x402 / MPP 402 challenges                  | passthrough by default; with `--json` an envelope: `tool_exit_code`, `response_body`, `payment` (kind/recipient/amount/asset/network) |
| `pact pause --json`                  | **admin only** — protocol kill switch                              | `action`, `tx_signature`, `protocol_config`, `authority`                                                          |

## Common patterns

- **`needs_funding` → call `pact approve <amount>` first.** If the agent has SOL but the USDC ATA is empty, the caller still needs to fund the ATA externally; `approve` only sets the delegation.
- **`auto_deposit_capped` → raise the cap or wait.** Edit `~/.config/pact/<project>/policy.yaml`:
  ```yaml
  per_deposit_max_usdc: 50    # raise both fields if you trust the run
  session_total_max_usdc: 200
  ```
  Or wait until next session — `session_used_usdc` resets per CLI invocation.
- **`endpoint_paused` → protocol- or endpoint-level kill switch is active.** Never auto-retry. Surface to the user; the operator will lift the pause.
- **`payment_failed` from `pact pay` → upstream is not Pact-aware.** The verifier rejected the `pact-allowance` authorization. Log the resource URL and surface; do not loop.

## Custody model

Pact uses SPL Token delegation, not a deposit-into-program model. Your USDC stays in your own associated token account (ATA). You grant the protocol's SettlementAuthority a fixed allowance with `pact approve <usdc>`; the protocol debits premiums from your ATA up to that allowance during settlement. You retain control of the funds at all times — `pact revoke` removes the allowance instantly.

Agents must fund their own mainnet USDC ATA externally (bridge or transfer in). `pact approve` does NOT move USDC; it only sets the delegation.

## Self-funding policy

You may run `pact approve <amount>` automatically as long as `<amount> <= per_deposit_max_usdc` AND your session total stays under `session_total_max_usdc`. Both caps live in `~/.config/pact/<project>/policy.yaml`. If `auto_deposit_capped` returns, surface to the user.

## `pact pay` — wrap any CLI through 402 challenges

When the user has a tool that hits a 402-gated paid API not on the insured list (e.g. an x402 or MPP endpoint), use `pact pay`. v0.1.0 supports `curl` only:

```bash
pact pay curl https://debugger.pay.sh/mpp/quote/AAPL
pact pay --json curl -s https://x402.example/v1/data    # structured envelope
```

`pact pay` runs the wrapped tool, intercepts a 402 response, signs a `pact-allowance` authorization with the project wallet, and re-runs the tool with the retry header attached. Without `--json` the wrapped tool's stdout passes through unchanged so you can `| jq '...'` as usual. With `--json` you get an `x402_payment_made` / `mpp_payment_made` / `payment_failed` envelope describing the payment scheme + the upstream's response.

## Trust + private beta

v0.1.0 runs against the live Pact Network mainnet program at `market.pactnetwork.io`. The protocol authority for the Treasury, settlement, and endpoint registration is currently held by the Pact Network founding team — see `docs/audits/2026-05-05-mainnet-readiness.md` for the open punch list (multisig rotation, third-party audit). The CLI surface here is private beta; reach the team in `#pact-network` on the Solder Discord, or open an issue at `github.com/pactnetwork/pact-monitor`.

## Critical rules

1. NEVER use `curl`, `fetch`, or `http` clients directly for the hostnames listed in the description above — they bypass insurance.
2. NEVER store the wallet private key in code or commits. It lives at `~/.config/pact/<project>/wallet.json` and is auto-generated on first run.
3. NEVER pass `--raw` unless the user explicitly asks for an uninsured call.
4. NEVER set `PACT_MAINNET_ENABLED=1` for an automated agent without the user's explicit consent — the gate is intentional friction.
5. If asked "what did Pact cost", run `pact agents show --json` and summarize `.body`.
