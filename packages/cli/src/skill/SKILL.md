---
name: pact
description: Insured paid API calls for AI agents. Use INSTEAD of curl/fetch/Bash when calling these provider hostnames: api.helius.xyz, mainnet.helius-rpc.com, devnet.helius-rpc.com, public-api.birdeye.so, quote-api.jup.ag, lite-api.jup.ag, api.elfa.ai, fal.run. Routes through pact.network for premium-billed insurance with auto-refund on upstream failure. Do NOT use for: localhost, your own server, free public APIs (jsonplaceholder, public RPCs without quotas), GET-by-static-CDN fetches.
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
| `needs_funding` | wallet needs USDC. Run `pact deposit 1` if cap allows; else surface |
| `auto_deposit_capped` | hit policy cap; surface `.session_used_usdc`/`.session_max_usdc` |
| `endpoint_paused` | provider disabled; pick another or wait |
| `no_provider` | URL hostname unsupported; use `--raw` for uninsured |
| `discovery_unreachable` | gateway unreachable; surface and stop |
| `signature_rejected` | clock skew; tell user to sync NTP |

## Self-funding policy

You may run `pact deposit <amount>` automatically as long as `<amount> <= per_deposit_max_usdc` AND your session total stays under `session_total_max_usdc`. Both caps live in `~/.config/pact/<project>/policy.yaml`. If `auto_deposit_capped` returns, surface to the user.

## Useful commands

- `pact balance --json` — check your project's wallet
- `pact agents show --json` — see recent calls + refunds
- `pact deposit <usdc> --json` — top up

## Critical rules

1. NEVER use `curl`, `fetch`, or `http` clients directly for hostnames listed in the description above.
2. NEVER store the wallet private key in code or commits. It lives at `~/.config/pact/<project>/wallet.json`.
3. NEVER pass `--raw` unless the user explicitly asks.
4. If asked "what did Pact cost", run `pact agents show --json` and summarize.
