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
pact balance                           # ATA balance + granted allowance
pact approve 5                         # SPL Token Approve to SettlementAuthority
pact revoke                            # remove the allowance
pact agents show
```

## Custody model

Your USDC stays in your own associated token account (ATA). `pact approve <usdc>` issues an SPL Token `Approve` ix that authorizes the protocol's `SettlementAuthority` PDA to debit up to `<usdc>` lamports during settlement. `pact approve` does **not** move funds — fund your ATA externally (Circle faucet on devnet; bridge or transfer on mainnet).

`pact balance` reports both ATA balance and currently-granted allowance plus an `eligible` flag mirroring what the program will see at debit time.

## Status taxonomy

Every `--json` invocation returns `{ status, body, meta }`. Status is one of:

- `ok`, `client_error`, `server_error` — exit 0, call attempted
- `needs_funding` (10) — ATA balance insufficient OR no allowance; remediate with `pact approve <usdc>`
- `auto_deposit_capped` (11), `endpoint_paused` (12)
- `no_provider` (20), `discovery_unreachable` (21)
- `signature_rejected` (30), `needs_project_name` (40), `cli_internal_error` (99)

## Configuration

Per-project state lives at `~/.config/pact/<project>/`:

- `wallet.json` — keypair (mode 0600)
- `policy.yaml` — auto-approve caps (also gates `pact approve`)
- `endpoints-cache.json` — discovery cache

Project name is resolved from `--project`, `$PACT_PROJECT`, git repo, or cwd basename.

## Env vars

- `PACT_PRIVATE_KEY` — bypass disk wallet
- `PACT_GATEWAY_URL` — override gateway (default `https://market.pactnetwork.io`)
- `PACT_RPC_URL` — override Solana RPC
- `PACT_CLUSTER` — `devnet` (default) or `mainnet`. `mainnet` requires `PACT_MAINNET_ENABLED=1` (closed-beta gate). Any other value is rejected at startup with a `client_error` envelope.
- `PACT_MAINNET_ENABLED=1` — opt in to `--cluster mainnet`. Without this, mainnet is rejected at parse time so a default build cannot route real USDC through the production program.
- `PACT_MAINNET_PROGRAM_ID` — required for the mainnet path; the canonical mainnet program ID is set after deploy and the binary will refuse to operate on mainnet without it.
- `PACT_AUTO_DEPOSIT_DISABLED=1` — disable auto-approve

See `docs/superpowers/specs/2026-05-05-pact-cli-design.md` for full spec.
