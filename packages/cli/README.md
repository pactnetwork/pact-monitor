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

## `--raw` (uninsured direct call)

Passing `--raw` calls the upstream URL directly, bypassing the gateway: no discovery, no balance check, no Pact signing headers, no premium debited, no refund on failure. The mainnet gate (`PACT_MAINNET_ENABLED=1`) still applies because cluster validation runs at every invocation. Use `--raw` only when the upstream is not yet onboarded (`no_provider`) or for one-off probes; the per-call envelope reports `meta.slug = "raw"`, `meta.call_id_source = "local_fallback"`, and `meta.raw = true`.

## Custody model

Your USDC stays in your own associated token account (ATA). `pact approve <usdc>` issues an SPL Token `Approve` ix that authorizes the protocol's `SettlementAuthority` PDA to debit up to `<usdc>` lamports during settlement. `pact approve` does **not** move funds — fund your mainnet USDC ATA externally (bridge or transfer in).

`pact balance` reports both ATA balance and currently-granted allowance plus an `eligible` flag mirroring what the program will see at debit time.

## `pact pay <tool> [args...]`

`pact pay` is a thin wrapper around
[solana-foundation/pay](https://github.com/solana-foundation/pay): it
forwards every argument verbatim to the `pay` binary, tee's stdout /
stderr / exit code straight back to the caller, and after `pay` exits
classifies the result so the Pact coverage policy can decide whether
the call qualifies for an SLA refund. The set of supported wrapped
tools is whatever `pay` itself supports (currently `curl`, `wget`,
`http` / HTTPie, `claude`, `codex`, `whoami`):

```bash
pact pay curl https://api.example.com/v1/quote/AAPL
pact pay wget https://api.example.com/v1/data.json
pact pay http POST https://api.example.com/v1/orders body=...
```

`pay` handles the 402 / x402 / MPP challenge, payment signing, and
retry; pact-cli does not parse 402 challenges itself. After `pay`
exits, `pact pay` emits a short `[pact]` summary block to stderr (or a
structured envelope to stdout when `--json` is passed) covering the
classifier verdict (`success` / `server_error` / `client_error` /
`payment_failed` / `tool_error`), the payment amount + asset when one
was attempted, and an SLA-policy hint when the upstream returned a 5xx.

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
- `PACT_GATEWAY_URL` — override gateway (default `https://api.pactnetwork.io`)
- `PACT_RPC_URL` — override Solana RPC (default `https://api.mainnet-beta.solana.com`)
- `PACT_CLUSTER` — only `mainnet` is accepted; any other value is rejected at startup with a `client_error` envelope. v0.1.0 is mainnet-only — local devnet testing requires sed-replacing `constants.rs` and rebuilding the program per Rick's runbook.
- `PACT_MAINNET_ENABLED=1` — required closed-beta gate. Any on-chain command (`balance`, `approve`, `revoke`, `<url>`) returns `client_error` until set, so a first-invocation accident cannot route real USDC through the production program.
- `PACT_AUTO_DEPOSIT_DISABLED=1` — disable auto-approve

See `docs/superpowers/specs/2026-05-05-pact-cli-design.md` for full spec.
