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
pact init                              # install Claude skill in this project (gateway flow)
pact --json https://api.helius.xyz/v0/addresses/<addr>/balances
pact balance                           # ATA balance + granted allowance
pact approve 5                         # SPL Token Approve to SettlementAuthority
pact revoke                            # remove the allowance
pact agents show
```

For the `pact pay` flow (wrapping any 402-gated tool), the signer is your pay.sh account, not the pact-managed wallet — so the prerequisites are different:

```bash
# 1. Install + set up pay.sh (one-time; provisions a Solana keypair into the Keychain)
curl -fsSL https://pay.sh/install.sh | sh
pay setup

# 2. Grant the SettlementAuthority an allowance from pay's account
pact approve 5                         # debits from pay's active account, not a pact wallet

# 3. Wrap any tool through 402 challenges (same signer pays + gets coverage)
pact pay curl https://api.example.com
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
classifies the result and registers the call for Pact coverage.

As of 0.3.0, `pact pay` and `pact approve` use **pay.sh's wallet** — they
read `~/.config/pay/accounts.yml`, find the active account, and shell out
to `pay account export <name> -` to get the signer. The agent that pays
the merchant is the same agent that holds the `pact approve` allowance,
gets premium-billed, and gets refunded on a breach. There is no separate
pact-managed wallet for this flow; `pay.sh` is a prerequisite unless you
override with `PACT_PRIVATE_KEY` (see [Env vars](#env-vars)). The bare
`pact <url>` gateway path is unchanged — it still uses
`~/.config/pact/<project>/wallet.json`.

On macOS the first `pay account export` per session pops a Touch ID
prompt; Keychain caches the auth for ~5 minutes so subsequent
invocations are silent. The `[pact]` summary block prints
`[pact] wallet: pay/<name> (xxxx…yyyy)` so you can see which pay account
signed the call.

The set of supported wrapped tools is whatever `pay` itself supports
(currently `curl`, `wget`, `http` / HTTPie, `claude`, `codex`,
`whoami`):

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
was attempted, and the **coverage** state (below).

Two things `pact pay` injects into the wrapped invocation so coverage
works end-to-end:

- **`-v` to `pay`** — so `pay` emits its verbose trace lines; without
  it the classifier can't see that a payment was attempted. Suppressed
  if you pass `--quiet` / `-q` / `--silent` to `pay`.
- **`-w '\n[pact-http-status=%{http_code}]\n'` to `curl`** (only when
  the wrapped tool is `curl` and you haven't already passed your own
  `-w` / `--write-out`) — plain `curl` forwards exit code 0 even on a
  5xx and doesn't surface the HTTP status, so without this marker the
  classifier would call a 5xx `success` and the `server_error → refund`
  SLA-breach path could never trigger via `pact pay curl`. The marker
  is just an extra trailing line on stdout; the happy path (200 → still
  `success`) is unaffected. (`curl -i` is *not* injected — it breaks
  `pay`'s own x402 challenge parsing; `-w` is safe.) Not injected for
  `wget` / `http` / `claude` / `codex`.

When `pay` uses the x402 auto-pay path (e.g. `pact pay curl
'https://merchant.example/quote?x402=1'`), the payment **amount** (base
units), **asset** (SPL mint), and **payee** (merchant address) are
extracted from `pay`'s verbose `Building x402 payment amount=… currency=…
recipient=… signer=…` log line and included in the receipt POSTed to
`facilitator.pactnetwork.io/v1/coverage/register` — so the facilitator
can price and (on a breach) refund the call. (`pay 0.13.x` and `0.16.x`
output formats are both handled.)

### Coverage (`facilitator.pactnetwork.io`)

When a payment was attempted, `pact pay` makes a side-call to
`facilitator.pactnetwork.io` to register the call for Pact coverage. It's
the *side-call* model: `pay` has already settled the payment directly
with the merchant; the facilitator records the receipt, charges a small
premium (debited from your `pact approve` allowance — exactly like the
gateway path), and on a covered failure (e.g. the upstream returned a
5xx after you paid) issues a refund from the subsidised `pay-default`
coverage pool — settled on-chain via the same `settle_batch` transaction
the `pact <url>` path uses.

The `[pact]` block reports one of:

- `[pact] base <amt> <asset> + premium <amt> (covered: pool pay-default) (coverage <id>)` — registered; premium + (on a breach) refund settling on-chain. On a breach you also get `[pact] policy: refund_on_<verdict> — refund <amt> settling on-chain (coverage <id>)` and `[pact] check status: pact pay coverage <id>`.
- `[pact] base <amt> <asset> + premium 0.000 (uncovered: <reason>)` — no coverage applied (e.g. `no_allowance` → run `pact approve` to enable it; the receipt is still recorded for analytics).
- `[pact] coverage skipped: no wallet — set up pay or PACT_PRIVATE_KEY` — no signer is resolvable. `~/.config/pay/accounts.yml` is missing/empty and `PACT_PRIVATE_KEY` is not set. The wrapped tool still runs; coverage just doesn't register.
- `[pact] base <amt> <asset> (coverage not recorded: facilitator unreachable)` — the side-call failed; the call still happened and `pay` already settled with the merchant, so this never fails the command or changes the exit code.

With `--json`, a `coverage` block is added to the envelope's `meta`:
`{ id, status, premiumBaseUnits, refundBaseUnits, pool: "pay-default", reason }`
(`status` ∈ `settlement_pending` / `uncovered` / `rejected` /
`facilitator_unreachable`). Pass `--no-coverage` to skip the facilitator
call entirely. `PACT_FACILITATOR_URL` overrides the facilitator base URL
(default `https://facilitator.pactnetwork.io`).

Check a coverage registration — and the on-chain `settle_batch`
signature once it's settled — with `pact pay coverage <coverageId>`:

```bash
pact pay coverage cov_abc123       # status + Solscan link once settled
```

(Once settled, the facilitator may also return a `callId`; `pact calls
<callId>` shows the full on-chain settlement record, same as a
gateway-path call.)

Note: pay 0.16.0's verbose output does not expose the merchant address
or the on-chain payment tx signature, so those fields are absent from
the receipt the CLI sends — the facilitator works with partial data.

The closed `PACT_MAINNET_ENABLED` gate that protects the other on-chain
commands is bypassed for `pact pay` when argv contains one of pay's
documented non-mainnet flags (`--sandbox`, `--dev`, `--local`); those
flows route to a local Surfpool / hosted sandbox and carry zero
mainnet exposure.

On macOS, the first `pact pay` (or `pact approve`) per shell session
triggers a Touch ID prompt — that's `pay account export` shelling out
to read the keypair from Keychain. Keychain caches the auth for ~5
minutes so subsequent invocations are silent. If pay.sh has never been
configured, `pact pay` probes via `pay account list` before spawning
and prints a one-line heads-up to stderr telling you to run `pay setup`;
the warning never blocks the call.

## Admin: `pact pause`

`pact pause` flips the protocol-wide kill switch — every subsequent `settle_batch` call returns `ProtocolPaused (6032)` until the same instruction is sent again with `paused = 0`. The signer must equal `ProtocolConfig.authority` on-chain.

Usage requires `PACT_PRIVATE_KEY` to hold the authority's secret key (a base58-encoded secret key, a `solana-keygen` JSON byte-array keypair file, or a path to such a file) — the command refuses to fall back to the project wallet or to generate a new keypair. End-users do not run this; it exists for the protocol operator's incident-response runbook.

## Waiting for on-chain settlement (`--wait`)

Settlement is **asynchronous**. A `pact <url>` call returns as soon as the
upstream responds — *before* the on-chain `settle_batch` transaction lands. The
settler batches insured-call events and submits `settle_batch` roughly
`meta.settlement_eta_sec` (~8s) later, so the immediate `--json` envelope has
`meta.tx_signature: null` and `meta.premium_lamports` is a pre-settlement
*estimate* (often `0`). The real tx signature and charged premium show up via
`pact calls show <call_id>` after the batch settles.

Pass `--wait` to have the CLI do that polling for you:

```bash
pact https://api.helius.xyz/v0/addresses/<addr>/balances --wait        # default 30s window
pact --wait=60 https://api.helius.xyz/v0/addresses/<addr>/balances     # custom window (1..300s)
```

With `--wait`, after an insured call returns the CLI polls
`GET <gateway>/v1/calls/<call_id>` (the same query `pact calls show` uses) every
~3s until the `Call` row has a signature or the window elapses, then merges the
settled fields into the `--json` envelope's `meta`: `meta.tx_signature`,
`meta.premium_lamports` / `meta.premium_usdc` (real values), `meta.refund_lamports` /
`meta.refund_usdc`, `meta.breach` (+ `meta.breach_reason`), `meta.settled_at`,
`meta.settled_latency_ms`, and `meta.solscan_url = https://solscan.io/tx/<sig>`. In
a TTY it also prints `[pact] settled on-chain: <sig> — https://solscan.io/tx/<sig>`
(plus `(refunded <amt> USDC)` on a breach). If the window elapses without
settlement, `tx_signature` stays `null` but `meta.settlement_pending: true` and
`meta.settlement_hint` (`run \`pact calls show <call_id>\` later`) are added.

Without `--wait` the behaviour is unchanged: the call returns immediately and
you fetch the tx later with `pact calls show <call_id>`. `--wait` only applies
to the gateway `pact <url>` path; for `pact pay` use `pact pay coverage <id>`
to check settlement.

> **Flag placement quirk:** `--wait` takes an optional value, so put it **after**
> the URL (`pact <url> --wait`) or use the `=` form (`pact --wait=30 <url>`).
> `pact --wait <url>` (space-separated, before the URL) makes commander treat the
> URL as `--wait`'s value — use one of the two forms above instead.

## Gotchas

- **Quote URLs that contain `?` (or `&`, `*`, `[`).** In zsh, `pact --json https://dummy.pactnetwork.io/quote/AAPL?fail=1` fails with `zsh: no matches found` because zsh glob-expands the `?`; bash has the same issue if `nullglob`/`failglob` is on. Always single-quote: `pact --json 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'`. This is a shell-quoting issue, not a `pact` bug.
- **Settlement is asynchronous — `meta.tx_signature: null` on the immediate response is expected.** See [`--wait`](#waiting-for-on-chain-settlement---wait) above. The on-chain `settle_batch` lands ~`meta.settlement_eta_sec` after the call; use `--wait` to poll for it, or `pact calls show <call_id>` later. Likewise `meta.premium_lamports` on the immediate response is a pre-settlement estimate (often `0`); the real charged premium is in `pact calls show` (or in `meta` after `--wait` settles).

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

- `PACT_PRIVATE_KEY` — supplies the signing key directly. For the gateway path (`pact <url>`, `pact balance`, `pact revoke`, etc.) it bypasses the disk wallet at `~/.config/pact/<project>/wallet.json`. For the `pact pay` / `pact approve` flow (which normally uses pay.sh's active account) it's the **headless fallback** — when set, pact-cli skips the `pay account export` shell-out and uses this key instead, so CI runners and containers without a Keychain still work. Accepts a base58-encoded 64-byte secret key (Phantom-style export), a JSON byte-array keypair `[n, …]` of length 64 (the `solana-keygen` / Solana CLI keypair file format), **or a path to a file** containing either of those (e.g. `PACT_PRIVATE_KEY=~/keys/agent.json` or `PACT_PRIVATE_KEY=$(cat agent.json)`). See also the `--keypair <path>` flag.
- `PACT_GATEWAY_URL` — override gateway (default `https://api.pactnetwork.io`)
- `PACT_RPC_URL` — override Solana RPC (default `https://api.mainnet-beta.solana.com`)
- `PACT_CLUSTER` — only `mainnet` is accepted; any other value is rejected at startup with a `client_error` envelope. v0.1.0 is mainnet-only — local devnet testing requires sed-replacing `constants.rs` and rebuilding the program per Rick's runbook.
- `PACT_MAINNET_ENABLED=1` — required closed-beta gate. Any on-chain command (`balance`, `approve`, `revoke`, `<url>`) returns `client_error` until set, so a first-invocation accident cannot route real USDC through the production program.
- `PACT_FACILITATOR_URL` — override the `pact pay` coverage facilitator base URL (default `https://facilitator.pactnetwork.io`)
- `PACT_AUTO_DEPOSIT_DISABLED=1` — disable auto-approve

Global flag: `--keypair <path>` — load the agent keypair from `<path>` (same format tolerance as `PACT_PRIVATE_KEY`: base58 secret key or `solana-keygen` JSON byte array). Precedence: `--keypair` > `PACT_PRIVATE_KEY` > disk wallet.

See `docs/superpowers/specs/2026-05-05-pact-cli-design.md` for full spec.
