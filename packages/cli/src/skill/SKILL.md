---
name: pact
version: 0.2.5
description: Insured paid API calls for AI agents on Solana. Use INSTEAD of curl/fetch/Bash when calling these provider hostnames: api.helius.xyz, mainnet.helius-rpc.com, public-api.birdeye.so, quote-api.jup.ag, lite-api.jup.ag, api.elfa.ai, fal.run. Routes through api.pactnetwork.io for premium-billed insurance with auto-refund on upstream failure. Mainnet-only; requires PACT_MAINNET_ENABLED=1. Use `pact pay <tool> [args...]` (wraps solana-foundation/pay; supported tools include curl, wget, http, claude, codex) to call any 402-gated x402 or MPP endpoint — it registers the call for Pact coverage at facilitator.pact.network (premium from your `pact approve` allowance, refund from the subsidised pay-default pool on a breach). Do NOT use for: localhost, your own server, free public APIs (jsonplaceholder, public RPCs without quotas), GET-by-static-CDN fetches.
---

# Pact — insured API calls for AI agents

> **v0.1.0 — Mainnet only.** Real USDC. Closed beta gate: `PACT_MAINNET_ENABLED=1` must be set in the environment before any command runs.

You have access to `pact`, a CLI that wraps API calls and insures them automatically. Calls go through Pact Network's gateway at `api.pactnetwork.io`; if the upstream fails an SLA, your agent's USDC is auto-refunded out of the per-endpoint coverage pool.

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
| `no_provider`           | 20   | endpoint not yet onboarded — terminal during private beta          | use `--raw` for an uninsured direct call (no gateway, no Pact signing, no premium), or request access from the Pact team. v0.1.0 has no auto-provision flow; manual onboarding only |
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
| `pact <url>` (`--wait` opt.)          | insured GET/POST through the gateway; `--wait` polls on-chain settlement (~8s) and fills in `meta.tx_signature` | upstream JSON; `meta.slug`, `meta.call_id`, `meta.call_id_source` (`gateway` \| `local_fallback`), `meta.latency_ms`, `meta.premium_lamports`, `meta.premium_usdc` (derived from gateway `X-Pact-Premium` header), `meta.refund_lamports`, `meta.settlement_pending`, `meta.tx_signature` (always `null` in the immediate envelope; the on-chain `settle_batch` signature surfaces in `GET /api/calls/:id` once the settler submits, typically 5-60s — use `--wait` or `pact calls show <call_id>` to surface it), `meta.solscan_url`/additional `meta.premium_*`/`meta.refund_*` after `--wait` settles |
| `pact balance --json`                | wallet pubkey + ATA balance + granted allowance                    | `wallet`, `ata`, `ata_balance_usdc`, `allowance_usdc`, `eligible`                                                |
| `pact approve <usdc> --json`         | grant SPL Token allowance to SettlementAuthority                   | `tx_signature`, `allowance_usdc`, `confirmation_pending`                                                          |
| `pact revoke --json`                 | clear the allowance                                                | `tx_signature`, `confirmation_pending`                                                                            |
| `pact agents show --json [pubkey]`   | recent calls + refunds for this agent                              | upstream agent state from indexer                                                                                |
| `pact agents watch`                  | SSE stream of live events (line-delimited JSON)                    | one event per line                                                                                                |
| `pact pay curl [args] [--json] [--no-coverage]` | wrap a CLI tool through x402 / MPP 402 challenges + register Pact coverage | passthrough by default; with `--json` an envelope: `body.tool_exit_code`, `body.classifier`, `body.payment`, `meta.coverage` (`{id,status,premiumBaseUnits,refundBaseUnits,pool,reason}`) |
| `pact pay coverage <coverageId>`     | check a `pact pay` coverage registration's status                  | `meta.coverage_status`, `meta.settle_batch_signature` + `meta.solscan_url` once settled, `meta.call_id` if returned |
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
- **`no_provider` → new provider, manual onboarding.** v0.1.0 does not auto-provision endpoints. New upstreams need a handler module shipped in a proxy redeploy — request access via the Pact team during private beta.

## Custody model

Pact uses SPL Token delegation, not a deposit-into-program model. Your USDC stays in your own associated token account (ATA). You grant the protocol's SettlementAuthority a fixed allowance with `pact approve <usdc>`; the protocol debits premiums from your ATA up to that allowance during settlement. You retain control of the funds at all times — `pact revoke` removes the allowance instantly.

The agent keypair lives at `~/.config/pact/<project>/wallet.json` (auto-generated on first run). To supply it yourself, set `PACT_PRIVATE_KEY` or pass `--keypair <path>`; both accept a base58-encoded secret key, a `solana-keygen` JSON byte-array keypair (`[n, …]`, 64 numbers), **or a path to a file** containing either. Precedence: `--keypair` > `PACT_PRIVATE_KEY` > disk wallet.

Agents must fund their own mainnet USDC ATA externally (bridge or transfer in). `pact approve` does NOT move USDC; it only sets the delegation.

## Self-funding policy

You may run `pact approve <amount>` automatically as long as `<amount> <= per_deposit_max_usdc` AND your session total stays under `session_total_max_usdc`. Both caps live in `~/.config/pact/<project>/policy.yaml`. If `auto_deposit_capped` returns, surface to the user.

## `pact pay` — wrap any CLI through 402 challenges (with coverage)

When the user has a tool that hits a 402-gated paid API not on the insured list (e.g. an x402 or MPP endpoint), use `pact pay`. `pact pay` is a thin wrapper around [solana-foundation/pay](https://github.com/solana-foundation/pay) — the wrapped-tool list is whatever `pay` itself supports (currently `curl`, `wget`, `http` / HTTPie, `claude`, `codex`, `whoami`):

```bash
pact pay curl https://debugger.pay.sh/mpp/quote/AAPL
pact pay wget https://api.example.com/v1/data.json
pact pay --json curl -s https://x402.example/v1/data    # structured envelope
pact pay --no-coverage curl https://x402.example/v1/data # skip the facilitator side-call
```

`pay` handles the 402 / x402 / MPP challenge, payment signing, and retry; pact-cli does not parse 402 challenges itself. Without `--json` the wrapped tool's stdout passes through unchanged so you can `| jq '...'` as usual; pact adds a short `[pact]` classifier + coverage summary on stderr. With `--json` you get an envelope whose `.status` is one of `ok` / `payment_failed` / `tool_error` / `client_error` / `server_error` plus a `.body.classifier` field describing the verdict, `.body.payment` describing the scheme + amount when one was attempted, and `.meta.coverage` describing the Pact coverage decision.

### Coverage is real now (the side-call model)

When a payment was attempted, `pact pay` makes a side-call to `facilitator.pact.network` to register the call for Pact coverage. `pay` has *already* settled the payment directly with the merchant; the facilitator then records the receipt, charges a small **premium** debited from your `pact approve` allowance (same mechanism as the `pact <url>` gateway path), and on a covered failure (e.g. the upstream returned a 5xx after you paid) issues a **refund** from the subsidised `pay-default` coverage pool — settled on-chain via the same `settle_batch` transaction the gateway path uses.

The `[pact]` block reports the coverage state:

- `[pact] base <amt> <asset> + premium <amt> (covered: pool pay-default) (coverage <id>)` — registered; premium + (on a breach) refund settling on-chain. On a breach you also get `[pact] policy: refund_on_<verdict> — refund <amt> settling on-chain (coverage <id>)` and `[pact] check status: pact pay coverage <id>`.
- `[pact] base <amt> <asset> + premium 0.000 (uncovered: <reason>)` — no coverage applied. If `<reason>` is `no_allowance`, run `pact approve <usdc>` to enable coverage; the receipt is still recorded for analytics.
- `[pact] base <amt> <asset> (coverage not recorded: facilitator unreachable)` — the side-call failed; the call still happened and `pay` already settled with the merchant, so the command never fails and the exit code is unchanged.

In `--json` mode `.meta.coverage` is `{ id, status, premiumBaseUnits, refundBaseUnits, pool: "pay-default", reason }` where `status` ∈ `settlement_pending` / `uncovered` / `rejected` / `facilitator_unreachable`.

Check a coverage registration — and the on-chain `settle_batch` signature once it's settled — with `pact pay coverage <coverageId>` (it returns a Solscan link once settled; if the facilitator also returns a `callId`, `pact calls <callId>` shows the full on-chain record). Pass `--no-coverage` to skip the facilitator call entirely. `PACT_FACILITATOR_URL` overrides the facilitator base URL (default `https://facilitator.pact.network`).

Caveat: pay 0.16.0's verbose output does not expose the merchant address or the on-chain payment tx signature, so those fields are absent from the receipt the CLI sends — the facilitator works with partial data.

## Notes — async settlement & shell quoting (read before debugging "it's broken")

- **`meta.tx_signature: null` on the immediate response is NOT a bug — settlement is asynchronous.** `pact <url>` returns as soon as the upstream responds; the on-chain `settle_batch` tx lands ~`meta.settlement_eta_sec` (≈8s) later because the settler batches events. The tx signature (and the *real* charged premium — `meta.premium_lamports` on the immediate response is a pre-settlement estimate, often `0`) appears via `pact calls show <call_id>` after the batch settles. To get it in one shot, pass `--wait` (default 30s poll window, `--wait=<secs>` to override): the CLI polls `pact calls show <call_id>` until settled, then merges `meta.tx_signature`, real `meta.premium_*`, `meta.refund_*`, `meta.breach`, `meta.settled_at`, and `meta.solscan_url` into the envelope. If the window elapses it sets `meta.settlement_pending: true` + `meta.settlement_hint` instead. Place `--wait` after the URL (`pact <url> --wait`) or use `pact --wait=30 <url>` — `pact --wait <url>` makes commander eat the URL as the flag value.
- **Quote URLs with `?` (or `&`, `*`, `[`) in zsh/bash.** `pact --json https://dummy.pactnetwork.io/quote/AAPL?fail=1` → `zsh: no matches found` (zsh glob-expands `?`; bash with `failglob`/`nullglob` too). Single-quote it: `pact --json 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'`. Shell-quoting issue, not a `pact` bug.

## Trust + private beta

v0.1.0 runs against the live Pact Network mainnet program at `api.pactnetwork.io`. The protocol authority for the Treasury, settlement, and endpoint registration is currently held by the Pact Network founding team — see `docs/audits/2026-05-05-mainnet-readiness.md` for the open punch list (multisig rotation, third-party audit). The CLI surface here is private beta; reach the team in `#pact-network` on the Solder Discord, or open an issue at `github.com/pactnetwork/pact-monitor`.

## Critical rules

1. NEVER use `curl`, `fetch`, or `http` clients directly for the hostnames listed in the description above — they bypass insurance.
2. NEVER store the wallet private key in code or commits. It lives at `~/.config/pact/<project>/wallet.json` and is auto-generated on first run.
3. NEVER pass `--raw` unless the user explicitly asks for an uninsured call. `--raw` bypasses the gateway entirely and calls the upstream URL directly with the user's headers/method/body — no discovery, no balance check, no Pact signing, no premium, no refund. The closed-beta gate (`PACT_MAINNET_ENABLED=1`) still applies because the cluster validator runs at every CLI invocation.
4. NEVER set `PACT_MAINNET_ENABLED=1` for an automated agent without the user's explicit consent — the gate is intentional friction.
5. If asked "what did Pact cost", run `pact agents show --json` and summarize `.body`.
