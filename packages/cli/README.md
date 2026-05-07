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
pact pay curl https://api.example.com  # wrap any tool through 402 challenges
```

## Custody model

Your USDC stays in your own associated token account (ATA). `pact approve <usdc>` issues an SPL Token `Approve` ix that authorizes the protocol's `SettlementAuthority` PDA to debit up to `<usdc>` lamports during settlement. `pact approve` does **not** move funds — fund your mainnet USDC ATA externally (bridge or transfer in).

`pact balance` reports both ATA balance and currently-granted allowance plus an `eligible` flag mirroring what the program will see at debit time.

## `pact pay <tool> [args...]`

Wrap any CLI tool so its 402-gated requests settle through the agent's
existing SPL Approve allowance to `SettlementAuthority`. Calling convention
matches [solana-foundation/pay](https://github.com/solana-foundation/pay):

```bash
pact pay curl https://api.example.com/v1/quote/AAPL
pact pay curl -X POST -d '{...}' https://api.example.com/v1/orders
```

When the upstream returns 402 with an `X-Payment-Required` header (x402) or
`WWW-Authenticate: SolanaCharge ...` (MPP), `pact pay` parses the challenge,
signs a `pact-allowance` authorization with the project wallet, and re-runs
the wrapped tool with the retry header attached. Stdout / stderr / exit code
of the wrapped tool pass through transparently — `pact pay` only emits a
JSON envelope on failure paths (unsupported tool, payment rejected, unknown
402, retry failure).

There is no per-call biometric prompt: the project wallet is on-disk at
`~/.config/pact/<project>/wallet.json`, and the on-chain debit happens
server-side via Pact's gateway using the previously-granted allowance.

v0.1.0 supports `curl` only. Other tools (`wget`, `http` (HTTPie), `claude`,
`codex`) are explicit non-MVP and return a `client_error` envelope so
callers can detect the gap programmatically.

## Admin: `pact pause`

`pact pause` flips the protocol-wide kill switch — every subsequent `settle_batch` call returns `ProtocolPaused (6032)` until the same instruction is sent again with `paused = 0`. The signer must equal `ProtocolConfig.authority` on-chain.

Usage requires `PACT_PRIVATE_KEY` to hold the authority's base58 secret key — the command refuses to fall back to the project wallet or to generate a new keypair. End-users do not run this; it exists for the protocol operator's incident-response runbook.

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
- `PACT_RPC_URL` — override Solana RPC (default `https://api.mainnet-beta.solana.com`)
- `PACT_CLUSTER` — only `mainnet` is accepted; any other value is rejected at startup with a `client_error` envelope. v0.1.0 is mainnet-only — local devnet testing requires sed-replacing `constants.rs` and rebuilding the program per Rick's runbook.
- `PACT_MAINNET_ENABLED=1` — required closed-beta gate. Any on-chain command (`balance`, `approve`, `revoke`, `<url>`) returns `client_error` until set, so a first-invocation accident cannot route real USDC through the production program.
- `PACT_AUTO_DEPOSIT_DISABLED=1` — disable auto-approve

See `docs/superpowers/specs/2026-05-05-pact-cli-design.md` for full spec.
