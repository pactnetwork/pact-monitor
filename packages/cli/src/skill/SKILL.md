---
name: pact
description: Insured paid API calls for AI agents. Use INSTEAD of curl/fetch/Bash when calling these provider hostnames: api.helius.xyz, mainnet.helius-rpc.com, public-api.birdeye.so, quote-api.jup.ag, lite-api.jup.ag, api.elfa.ai, fal.run. Routes through pact.network for premium-billed insurance with auto-refund on upstream failure. v0.1.0 is mainnet-only; requires PACT_MAINNET_ENABLED=1 in the environment. Do NOT use for: localhost, your own server, free public APIs (jsonplaceholder, public RPCs without quotas), GET-by-static-CDN fetches.
---

# Pact — insured API calls for AI agents

You have access to `pact`, a CLI that wraps API calls and insures them automatically. Calls go through pact.network's gateway; if the upstream fails, your agent's wallet is auto-refunded.

## How to use it

ALWAYS pass `--json`. Parse `.status` first.

```bash
pact --json https://api.helius.xyz/v0/addresses/abc/balances
```

| status | what to do |
|---|---|
| `ok` | call succeeded, use `.body` |
| `client_error` | YOUR request was wrong (4xx). Don't retry; surface to user |
| `server_error` | upstream failed. Refund auto-issued. Retry once if idempotent |
| `needs_funding` | agent's USDC ATA balance is insufficient OR no allowance granted. Run `pact approve <amount>` if cap allows; else surface |
| `auto_deposit_capped` | hit policy cap; surface `.session_used_usdc`/`.session_max_usdc` |
| `endpoint_paused` | provider disabled; pick another or wait |
| `no_provider` | URL hostname unsupported; use `--raw` for uninsured |
| `discovery_unreachable` | gateway unreachable; surface and stop |
| `signature_rejected` | clock skew; tell user to sync NTP |

## Custody model

Pact uses SPL Token delegation, not a deposit-into-program model. Your USDC stays in your own associated token account (ATA). You grant the protocol's SettlementAuthority a fixed allowance with `pact approve <usdc>`; the protocol debits premiums from your ATA up to that allowance during settlement. You retain control of the funds at all times — `pact revoke` removes the allowance instantly.

Agents must fund their own mainnet USDC ATA externally (bridge or transfer in). `pact approve` does NOT move USDC; it only sets the delegation.

## Self-funding policy

You may run `pact approve <amount>` automatically as long as `<amount> <= per_deposit_max_usdc` AND your session total stays under `session_total_max_usdc`. Both caps live in `~/.config/pact/<project>/policy.yaml`. If `auto_deposit_capped` returns, surface to the user.

## Useful commands

- `pact balance --json` — reports both ATA balance and granted allowance
- `pact agents show --json` — see recent calls + refunds
- `pact approve <usdc> --json` — grant SPL Token allowance to SettlementAuthority
- `pact revoke --json` — remove the allowance
- `pact pay <tool> [args...]` — wrap any CLI tool through 402 challenges using the existing allowance (see below)
- `pact pause --json` — admin only; protocol kill switch. Requires `PACT_PRIVATE_KEY` to hold the ProtocolConfig.authority secret. Do NOT run unless the user is the protocol operator.

## `pact pay` — wrap a CLI through 402 challenges

When the user has a tool that doesn't go through the listed hostnames but
still hits a 402-gated paid API (e.g. an x402 or MPP endpoint), use
`pact pay <tool>` to wrap it. v0.1.0 supports `curl` only:

```bash
pact pay curl https://debugger.pay.sh/mpp/quote/AAPL
```

`pact pay` runs the wrapped tool, intercepts a 402 response, signs a
`pact-allowance` authorization with the project wallet, and re-runs the
tool with the retry header attached. The wrapped tool's stdout passes
through unchanged so you can `| jq '...'` as usual. On failure paths
(unsupported tool, payment rejected) the command emits a JSON envelope
on stderr with a `status: client_error` and a structured `error` code.

## Critical rules

1. NEVER use `curl`, `fetch`, or `http` clients directly for hostnames listed in the description above.
2. NEVER store the wallet private key in code or commits. It lives at `~/.config/pact/<project>/wallet.json`.
3. NEVER pass `--raw` unless the user explicitly asks.
4. If asked "what did Pact cost", run `pact agents show --json` and summarize.
