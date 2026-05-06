# @q3labs/pact-cli

`pact` — insured paid API calls for AI agents.

## Install

```bash
pnpm add -g @q3labs/pact-cli      # via pnpm
npm install -g @q3labs/pact-cli   # via npm
```

Or one-liner:

```bash
curl -fsSL https://pactnetwork.io/install.sh | sh
```

## Quick start

```bash
pact init                              # install Claude skill in this project
pact --json https://api.helius.xyz/v0/addresses/<addr>/balances
pact balance
pact deposit 5
pact agents show
```

## Status taxonomy

Every `--json` invocation returns `{ status, body, meta }`. Status is one of:

- `ok`, `client_error`, `server_error` — exit 0, call attempted
- `needs_funding` (10), `auto_deposit_capped` (11), `endpoint_paused` (12)
- `no_provider` (20), `discovery_unreachable` (21)
- `signature_rejected` (30), `needs_project_name` (40), `cli_internal_error` (99)

## Configuration

Per-project state lives at `~/.config/pact/<project>/`:

- `wallet.json` — keypair (mode 0600)
- `policy.yaml` — auto-deposit caps
- `endpoints-cache.json` — discovery cache

Project name is resolved from `--project`, `$PACT_PROJECT`, git repo, or cwd basename.

## Env vars

- `PACT_PRIVATE_KEY` — bypass disk wallet
- `PACT_GATEWAY_URL` — override gateway (default `https://market.pactnetwork.io`)
- `PACT_RPC_URL` — override Solana RPC
- `PACT_CLUSTER` — `devnet` only in v0.1.0; mainnet is gated to the Friday harden pass. Any other value is rejected at startup with a `client_error` envelope.
- `PACT_AUTO_DEPOSIT_DISABLED=1` — disable auto-deposit

See `docs/superpowers/specs/2026-05-05-pact-cli-design.md` for full spec.
