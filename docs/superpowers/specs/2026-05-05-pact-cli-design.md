# Pact CLI — Design Spec

**Date:** 2026-05-05
**Author:** Alan (with assistant)
**Status:** Locked, pending implementation
**Target ship:** Wed 2026-05-06 (devnet). Friday harden 2026-05-08. Mainnet floor by Saturday 2026-05-10. Colosseum submission Mon 2026-05-11.

---

## 1. Purpose

`pact` is a curl-shaped command-line client that lets AI coding agents (specifically Claude Code) make insured paid API calls without writing on-chain code, managing keypairs manually, or implementing premium/refund accounting. It wraps the existing `pact-insurance` Solana program and the `pact-proxy` HTTP gateway behind one binary.

The product is the **agent-paying-the-bill** moment. When Claude Code calls `pact <url>`, the call goes through Pact Network's gateway, the agent's wallet is debited a small premium, the upstream provider returns a response, and if the upstream fails the agent's wallet is auto-refunded by the existing on-chain settlement loop. From the agent's perspective the experience is identical to `curl`, with the addition of a structured JSON envelope (`--json`) that exposes status, premium, and call ID for autonomous decision-making.

The CLI is the third user-facing surface alongside the SDK (`@q3labs/pact-insurance`, `@q3labs/pact-monitor`) and the dashboard (`dashboard.pactnetwork.io`). It exists to make the killer hackathon demo land in a single command and to be a real production tool that survives beyond the demo.

## 2. Goals and non-goals

**Goals:**

- An autonomous Claude Code agent can install the skill, get a wallet, call insured APIs, handle funding gaps, and report results — all without human intervention beyond initial deposit-on-mainnet authorization.
- `pact <url>` is a drop-in for `curl <url>` for the five providers Pact Market supports at launch (Helius, Birdeye, Jupiter, Elfa, fal.ai).
- Sub-30ms cold start so agent loops feel native.
- Production-grade (not demo-ware): closed error contract, signed requests, auto-deposit caps, structured envelopes for every failure path.

**Non-goals:**

- Not a generic Solana CLI. It does not expose arbitrary RPC calls or signing — only operations specific to the Pact Market product.
- Not an operator console. `pact ops` is intentionally absent; operators use the dashboard.
- Not a wallet manager. There is no `pact wallet new` or `pact wallet export` for V1; per-project wallets auto-create and stay scoped to the project.
- Not a mainnet ship for Wed. Mainnet capability is gated behind Saturday's hardening list.

## 3. Architecture

```
                ┌──────────────────────────────────────┐
                │  Claude Code session                 │
                │   .claude/skills/pact/SKILL.md       │
                │       (frontmatter triggers on       │
                │        known provider hostnames)     │
                └──────────────┬───────────────────────┘
                               │ shells out
                               ▼
                ┌──────────────────────────────────────┐
                │  pact CLI (Bun-compiled binary)      │
                │   ~/.config/pact/<project>/          │
                │     ├─ wallet.json   (keypair)       │
                │     ├─ endpoints-cache.json          │
                │     ├─ policy.yaml   (auto-deposit)  │
                │     └─ auto_deposits_session.json    │
                └─┬───────────────────────┬────────────┘
                  │                       │
                  ▼                       ▼
       market.pactnetwork.io        Solana RPC (devnet/mainnet)
       ├─ GET /.well-known/         (balance, deposit_usdc tx)
       │     endpoints              No Pact infra dep.
       ├─ POST /v1/<slug>/<path>
       ├─ GET /v1/agents/:pubkey
       └─ GET /v1/agents/:pubkey/
            events  (SSE stream)
```

**Single-host invariant:** the CLI never speaks to the indexer or the legacy backend. The proxy at `market.pactnetwork.io` owns every HTTP route the CLI uses. When a route needs indexer data (e.g., `pact agents show`), the proxy forwards internally and presents one public surface.

**Three external dependencies:**

1. `market.pactnetwork.io` — the proxy, for discovery and execution.
2. Solana RPC — for read-only balance lookups and deposit-tx submission.
3. Circle USDC faucet (devnet only) — invoked once per project during auto-bootstrap.

**Per-project state lives on disk under `~/.config/pact/<project>/`:**

- `wallet.json` — keypair, file mode `0600`. Plaintext base58 for V1 (Wed). OS keychain by Friday.
- `endpoints-cache.json` — discovery cache. TTL set by server response.
- `policy.yaml` — auto-deposit caps, user-editable.
- `auto_deposits_session.json` — running total of auto-deposits this session, used to enforce caps.
- `state.json` — last-known balance and last 50 call IDs for `pact agents show` summary without an immediate roundtrip.

**Project-name resolution priority:**

1. `--project <name>` CLI flag
2. `$PACT_PROJECT` env variable
3. Git repo name from `.git/config` `[remote "origin"]` URL (last path segment)
4. `path.basename(cwd)`

If none yields a stable name (e.g., `cwd` is `/tmp` in CI), CLI returns the structured envelope `{ status: "needs_project_name", suggest: "pass --project or set PACT_PROJECT" }` and exits 40.

## 4. File and module layout

```
packages/cli/
├── package.json                  # @q3labs/pact-cli, workspace deps on insurance + monitor
├── tsconfig.json
├── bunfig.toml                   # bun build --compile target
├── src/
│   ├── index.ts                  # entrypoint, argument parsing, command dispatch
│   ├── cmd/
│   │   ├── run.ts                # `pact <url>` — the killer command
│   │   ├── balance.ts            # `pact balance`
│   │   ├── deposit.ts            # `pact deposit <amount>`
│   │   ├── agents.ts             # `pact agents show [pubkey]`, --watch, <call_id>
│   │   └── init.ts               # `pact init` — adds CLAUDE.md snippet
│   ├── lib/
│   │   ├── project.ts            # project-name resolution
│   │   ├── wallet.ts             # load/create/save keypair, devnet faucet, mainnet halt
│   │   ├── discovery.ts          # fetch + cache /.well-known/endpoints, error invalidation
│   │   ├── transport.ts          # HTTP call, signing, retry, timeout
│   │   ├── envelope.ts           # JSON envelope shape, status mapping, exit codes
│   │   ├── output.ts             # TTY detection, --json mode, stderr metadata pretty-printer
│   │   ├── policy.ts             # auto-deposit cap enforcement
│   │   └── solana.ts             # @solana/kit RPC wrappers (balance, deposit_usdc, agent PDA)
│   └── skill/
│       ├── SKILL.md              # template, copied by `pact init`
│       └── claude-md-snippet.md  # template, appended by `pact init`
├── test/
│   ├── run.test.ts
│   ├── balance.test.ts
│   ├── deposit.test.ts
│   ├── agents.test.ts
│   ├── discovery.test.ts
│   ├── envelope.test.ts
│   ├── policy.test.ts
│   ├── transport.test.ts
│   └── helpers.ts
└── README.md
```

Each `src/lib/*` module has one purpose, narrow public interface, and is testable in isolation. `cmd/*` files are thin orchestrators that compose `lib/*` modules.

## 5. `pact <url>` data flow (the killer command)

When an agent runs `pact --json https://api.helius.xyz/v0/addresses/<addr>/balances`:

1. **Parse args.** URL, method (default GET), headers, body, output mode (`--json` | TTY default).

2. **Resolve project context.** Apply the four-tier resolution above.

3. **Load or create wallet.**
   - If `wallet.json` exists: load keypair, file mode validated `0600`.
   - If missing: generate fresh keypair, persist `wallet.json` with `0600`. Then:
     - **Devnet:** `requestAirdrop(0.5 SOL)`, call Circle USDC faucet for 10 USDC, wait for confirmations. Persist `state.json` with bootstrap timestamp. Continue.
     - **Mainnet:** halt. Return envelope `{ status: "needs_funding", wallet, needed_usdc: 5, deposit_url: "https://dashboard.pactnetwork.io/agents/<pubkey>" }`, exit 10.

4. **Resolve provider slug from URL hostname.**
   - Load `endpoints-cache.json`. If missing or TTL expired, fetch `GET market.pactnetwork.io/.well-known/endpoints`. Server response includes `cacheTtlSec`.
   - Match `url.hostname` against `provider.hostnames[]` for each provider in the cache.
   - If no match: if `--raw` flag set, call `url` directly with no rewriting (uninsured); otherwise return envelope `{ status: "no_provider", hostname, suggest: "pass --raw for an uninsured call" }`, exit 20.
   - If matched but `provider.paused === true`: return envelope `{ status: "endpoint_paused", slug, until: provider.unpause_eta_sec? }`, exit 12.
   - On match: `slug = "helius"`, `upstream_path = "/v0/addresses/<addr>/balances"`.

5. **Pre-flight balance check.**
   - Read agent's USDC ATA balance via Solana RPC.
   - Read `AgentWallet` PDA via `pact-insurance` program for `pendingRefund`.
   - Estimate premium: `provider.premiumBps × estimated_call_cost_usdc`. For V1 the estimate is conservative — round to one full premium tick (~$0.0001).
   - If `balance < estimated_premium`: return envelope `{ status: "needs_funding", wallet, needed_usdc, current_balance_usdc }`, exit 10.

6. **Build and send the proxied request.**
   - Target: `https://market.pactnetwork.io/v1/<slug>/<upstream_path>`.
   - Strip user-supplied provider API keys from query params and headers (proxy injects Pact's master key on the upstream side).
   - Add Pact auth headers:
     - `X-Pact-Agent: <pubkey>`
     - `X-Pact-Timestamp: <unix-ms>`
     - `X-Pact-Nonce: <random 16 bytes b58>`
     - `X-Pact-Project: <projectName>` (telemetry attribution; not part of the signed payload)
     - `X-Pact-Signature: nacl_sign("v1\n<method>\n<path>\n<ts>\n<nonce>\n<sha256(body)>", secretKey)`
   - Fetch with 30s default timeout. Two retries with exponential backoff (0.5s, 1.5s) on 5xx, network errors, and timeouts. Zero retries on 4xx. One additional retry after cache invalidation on 404 `unknown_slug`, 410 `slug_renamed`, 423 `endpoint_paused`.
   - Record start_time, end_time.

7. **Handle proxy response.** Map upstream status to outcome:
   - 2xx → `outcome: "ok"`, premium charged, no refund.
   - 4xx → `outcome: "client_error"`, premium charged, no refund (caller's bug).
   - 5xx, timeout, network failure → `outcome: "server_error"`, premium charged, refund eligible (settler will issue refund in next batch).
   - 404 with body `{ error: "unknown_slug" }` → invalidate cache, refresh, retry once.
   - 410 with `Pact-New-Slug` header → invalidate cache, refresh, retry once with new slug.
   - 423 → return `endpoint_paused` envelope; do not retry.

8. **Build envelope.**

   ```json
   {
     "status": "ok" | "client_error" | "server_error" | "needs_funding" | "auto_deposit_capped" | "endpoint_paused" | "no_provider" | "discovery_unreachable" | "signature_rejected" | "cli_internal_error",
     "body": "<upstream response body, parsed JSON or string>",
     "meta": {
       "slug": "helius",
       "call_id": "call_01HZ8X3M9P7K",
       "latency_ms": 287,
       "outcome": "ok",
       "premium_lamports": 100,
       "premium_usdc": 0.0001,
       "tx_signature": null,
       "settlement_eta_sec": 8
     }
   }
   ```

9. **Output.**
   - `--json` mode: print JSON envelope to stdout, nothing on stderr.
   - TTY default: print `body` to stdout (curl-like). Print one-line metadata to stderr (`✓ insured · helius · 287ms · 0.0001 USDC`).
   - Exit code: see section 7.

**Key design constants:**

- The CLI does not submit a Solana tx for every API call. The proxy publishes a settle event to Pub/Sub; the settler batches up to 50 events into one `settle_batch` tx asynchronously. `tx_signature` is `null` in the envelope until the call is later queryable via `pact agents show <call_id>`.
- All signing is local. The proxy never sees the private key. Replay protection is via timestamp window only for V1 (no nonce store); a 30s drift window is enforced server-side.
- The envelope's `status` field is the load-bearing branching point for Claude. The set is closed; SKILL.md enumerates every value.

## 6. Other commands

### `pact balance`

```
pact balance              → human: "Wallet 7g3...x9 · 12.30 USDC available · pending refund 0.05 USDC"
pact balance --json       → { "wallet": "...", "balance_usdc": 12.30, "pending_refund_usdc": 0.05 }
```

- Reads agent USDC ATA balance via Solana RPC.
- Reads `AgentWallet` PDA via existing `pact-insurance` program for `pendingRefund`.
- No Pact infra calls. Sub-second. No caching.

### `pact deposit <amount>`

```
pact deposit 5            → human: "Deposited 5 USDC. New balance 17.30 USDC. Tx: abc..."
pact deposit 5 --json     → { "status": "ok", "tx_signature": "...", "new_balance_usdc": 17.30, "confirmation_pending": false }
```

- Builds `deposit_usdc(amount)` instruction via `@q3labs/pact-insurance` SDK.
- Signs with agent keypair, submits to Solana RPC, polls for confirmation (up to 30s).
- If confirmation lands within 30s: `{ confirmation_pending: false, tx_signature, new_balance_usdc }`.
- If no confirmation after 30s: `{ confirmation_pending: true, tx_signature }`. SKILL.md instructs Claude to retry once after 5s.
- Devnet pre-flight: if agent has no USDC in ATA, calls Circle faucet automatically.
- Mainnet: if agent has no USDC, returns `{ status: "no_funds_to_deposit", wallet, suggest: "send USDC to <ata>" }`.

### `pact agents show [pubkey]`

```
pact agents show                       # default: this project's wallet
pact agents show 7g3...x9              # any pubkey, public read
pact agents show --json
pact agents show --watch               # SSE stream of incoming events
pact agents show <call_id>             # specific call lookup
```

- HTTP GET `market.pactnetwork.io/v1/agents/<pubkey>` — the proxy adds this passthrough route, internally calling the indexer.
- Output: balance, total deposits, total refunds claimed, last 10 calls (slug · outcome · latency · ts).
- `--watch` opens an SSE connection to `market.pactnetwork.io/v1/agents/<pubkey>/events` and prints each event as it lands. For demo: live receipt feed in a side terminal.
- `<call_id>` fetches a single call's full record, including settlement state.

### `pact init`

```
pact init                  # appends snippet to ./CLAUDE.md (or AGENTS.md), idempotent
```

- Writes a four-line "this project uses Pact" snippet to the project's `CLAUDE.md` to reinforce the skill matcher at the project-context level.
- Also installs the skill at `.claude/skills/pact/SKILL.md` if not present.
- No-op if both already present.

## 7. Status taxonomy and exit codes

The set is closed. SKILL.md enumerates every value. New statuses require a spec amendment.

| status | exit | semantic |
|---|---|---|
| `ok` | 0 | call succeeded, body valid |
| `client_error` | 0 | upstream returned 4xx; caller's bug; no refund |
| `server_error` | 0 | upstream 5xx/timeout/network; refund eligible |
| `needs_funding` | 10 | wallet balance insufficient for estimated premium |
| `auto_deposit_capped` | 11 | hit `policy.yaml` cap; cannot auto-fund |
| `endpoint_paused` | 12 | provider temporarily disabled by operator |
| `no_provider` | 20 | URL hostname not in registry; suggest `--raw` |
| `discovery_unreachable` | 21 | cannot fetch `/.well-known/endpoints` AND no cache available |
| `signature_rejected` | 30 | proxy refused signature; clock skew or bad signing |
| `needs_project_name` | 40 | could not resolve project name |
| `cli_internal_error` | 99 | bug in CLI; envelope contains stack trace |

Exit code 0 means **the call attempt completed**, even if the upstream returned 4xx (that's a successful uninsured outcome). Non-zero codes are CLI-level failures Claude must act on.

## 8. SKILL.md and agent integration

### Skill location

`.claude/skills/pact/SKILL.md` is installed by `pact init`. The skill activates based on its frontmatter `description` field, which lists the explicit hostname allowlist and the explicit do-not-use list.

### Frontmatter (skill matcher)

```yaml
---
name: pact
description: Insured paid API calls for AI agents. Use INSTEAD of curl/fetch/Bash
  when calling these provider hostnames: api.helius.xyz, mainnet.helius-rpc.com,
  devnet.helius-rpc.com, public-api.birdeye.so, quote-api.jup.ag, lite-api.jup.ag,
  api.elfa.ai, fal.run. Routes through pact.network for premium-billed insurance
  with auto-refund on upstream failure. Do NOT use for: localhost, your own server,
  free public APIs (jsonplaceholder, public RPCs without quotas), GET-by-static-CDN
  fetches.
---
```

### Body content (summarized — full template lives in `src/skill/SKILL.md`)

- **Always pass `--json`** to get a structured envelope.
- **Branch on `.status`:** the closed taxonomy from section 7.
- **Self-funding policy:** *"You may run `pact deposit <amount>` automatically as long as `<amount> <= per_deposit_max_usdc` AND your session total stays under `session_total_max_usdc`. Both caps live in `~/.config/pact/<project>/policy.yaml`. If `needs_funding` returns and either cap would be breached, surface to the user with `.wallet` and `.needed_usdc`."*
- **Useful commands:** `pact balance --json`, `pact agents show --json`, `pact deposit <usdc> --json`.
- **Critical rules:** never use curl directly for covered hostnames; never store wallet private key in code; never pass `--raw` unless user asks; surface costs via `pact agents show` when asked.

### CLAUDE.md project-pin snippet

`pact init` appends:

```markdown
## Paid API calls

This project uses Pact (`pact <url>`) for insured paid API calls. Whenever you
need to hit an external paid API (RPC, price feed, scraping), prefer `pact --json`
over curl/fetch/Bash. Pact handles wallet, premium, and refund automatically.
Run `pact --help` for details.
```

## 9. Auto-deposit policy

Per-project file `~/.config/pact/<project>/policy.yaml`, auto-created with safe defaults on first wallet bootstrap:

```yaml
auto_deposit:
  enabled: true
  per_deposit_max_usdc: 1.0
  session_total_max_usdc: 5.0
```

Enforcement lives in `lib/policy.ts`. Before calling `lib/wallet.deposit()`, the policy module checks:

1. `enabled` is true.
2. The requested deposit amount is ≤ `per_deposit_max_usdc`.
3. Sum of `auto_deposits_session.json` + requested amount ≤ `session_total_max_usdc`.

If any check fails, return `{ status: "auto_deposit_capped", session_used_usdc, session_max_usdc, suggest: "raise cap in policy.yaml or run pact deposit manually" }`. Exit 11.

Session boundary: a "session" is one CLI process tree, identified by the `PACT_SESSION_ID` env propagated from the parent. If unset, the CLI generates one and writes a fresh `auto_deposits_session.json`. Long-running agents inherit the session from their harness; one-shot invocations get fresh sessions per call (so a single auto-deposit per call is the cap, which is fine).

`PACT_AUTO_DEPOSIT_DISABLED=1` env disables auto-deposit entirely regardless of policy.

## 10. Security model

### Trust boundaries

| Boundary | Trusted? | What we protect |
|---|---|---|
| `pact CLI ↔ user filesystem` | Yes | `wallet.json` mode `0600`, OS keychain by Friday. Plaintext base58 acceptable on devnet only. |
| `pact CLI ↔ proxy` | No (private key) | CLI signs locally; proxy verifies. Proxy never sees secret. |
| `pact CLI ↔ Solana RPC` | Yes for reads | Reads are public. Writes are signed and submitted by CLI; proxy not involved. |
| `Claude ↔ pact CLI` | Cooperative | Claude has full shell access by definition. Pact provides a budget cap (auto-deposit policy), not access control. |
| `proxy ↔ upstream provider` | N/A | Proxy uses Pact's master API key; agents never see it. |

### Replay protection (V1, devnet)

Per-request signed payload:

```
v1\n<method>\n<path>\n<ts>\n<nonce>\n<sha256(body)>
```

Proxy enforces: `|now - ts| ≤ 30000ms`. No nonce store in V1; timestamp window is the only barrier. A passive sniffer with a 30s window can replay a call exactly once before it expires. For devnet, the worst-case loss is a duplicate $0.0001 premium charge.

**Friday harden:** add a Redis SET with 30s TTL on the proxy keyed by `(pubkey, nonce)`. Reject duplicates.

### Wallet storage

V1 (Wed):
- File at `~/.config/pact/<project>/wallet.json`, mode `0600`.
- Plaintext base58-encoded private key.
- CLI prints a one-time warning on first create: *"Wallet stored in plaintext. For mainnet use, upgrade to encrypted storage by running `pact wallet upgrade` (Friday)."*
- `PACT_PRIVATE_KEY` env override: CLI reads keypair from env, never touches disk.

Friday (mainnet floor):
- OS keychain integration (`keytar` shim for Bun): macOS Keychain, libsecret on Linux, DPAPI on Windows.
- `wallet.json` retains only the encrypted blob; wrap-key in keychain.
- `pact wallet rotate` command for key rotation.

### Mainnet gate

Mainnet capability is hard-gated behind a Saturday checklist:

- [ ] OS keychain integration shipped and tested on macOS + Linux + Windows
- [ ] Replay nonce store live in proxy
- [ ] `pact wallet rotate` shipped
- [ ] Second-pair review of `lib/wallet.ts` and `lib/transport.ts` (signature construction, key handling)
- [ ] `mainnet` cluster URL whitelisted in CLI; CLI hard-fails if `PACT_CLUSTER=mainnet` and any checklist item is missing.

The CLI carries a build-time flag `MAINNET_ENABLED`. False until Saturday.

## 11. Networking guarantees

- `pact <url>` total timeout: 30s default, configurable via `--timeout <seconds>`.
- 2 retries with exponential backoff (0.5s, 1.5s) on 5xx, network errors, timeouts.
- 0 retries on 4xx.
- 1 additional retry after cache invalidation on 404 `unknown_slug` / 410 `slug_renamed` / 423 `endpoint_paused`.
- `pact deposit` polls for confirmation up to 30s; returns `confirmation_pending: true` if not landed.
- All HTTP traffic uses HTTPS; certificate pinning is **not** in V1 (Friday harden if it makes the cut).

## 12. Output and logging

### Output mode selection

- `--json` flag: structured envelope to stdout, nothing on stderr.
- `--quiet` flag: body to stdout only, nothing on stderr.
- Default (TTY): body to stdout, one-line metadata to stderr.
- `--verbose` flag: body to stdout, full trace to stderr (request line, headers minus auth, response status, retry events).
- `$PACT_LOG=debug` env: same as `--verbose` and persists across the session.

### Logging (V1)

- No project log file in V1.
- `--verbose` is the only debugging surface. Streams to stderr live.

### Logging (Friday)

- `~/.config/pact/<project>/log/<YYYY-MM-DD>.log`, one line per CLI invocation.
- Format: `<ts> <command> <slug> <status> <latency_ms>`.
- Daily rotation, 7 days retained.
- `pact log show` tails today's log.

## 13. Implementation

### Language and runtime

TypeScript source. Single binary via `bun build --compile`. Reuses `@q3labs/pact-insurance` and `@q3labs/pact-monitor` workspace deps. Uses `@solana/kit` (not `@solana/web3.js` v1) for all RPC and signing.

### Build matrix

CI builds five binaries per release:

- `pact-darwin-arm64`
- `pact-darwin-x64`
- `pact-linux-x64`
- `pact-linux-arm64`
- `pact-windows-x64.exe`

### Distribution

- `npm publish @q3labs/pact-cli` — npm package with a `postinstall` script that downloads the right binary from GitHub Releases. Falls back to running TypeScript via `bun` if available locally.
- `curl -fsSL https://pactnetwork.io/install.sh | sh` — one-liner installer. Detects OS/arch, downloads binary, places at `/usr/local/bin/pact`.
- Skill: published as a Claude Code plugin entry; `pact init` installs it locally.

### Workspace placement

`packages/cli/` in the existing pnpm monorepo. Reuses the same tooling (`@pact-network/shared` for types, prettier config, vitest).

## 14. Wed shipping cut

What ships Wed (devnet only):

- All 7 commands functional.
- File-mode `0600` wallet storage; `PACT_PRIVATE_KEY` env override.
- Signed requests (timestamp + 30s window, no nonce store).
- Closed status taxonomy, all 11 statuses implemented.
- Auto-deposit caps (`policy.yaml`).
- Networked discovery + TTL cache + error invalidation.
- `--json` mode + TTY mode.
- `pact agents show --watch` SSE.
- Bun-compiled binary for darwin-arm64 + linux-x64 (the laptops in the room).
- SKILL.md template + `pact init`.
- 30+ unit tests across all `lib/*` modules, integration tests against a local proxy mock.

What slips to Friday harden:

- OS keychain integration (`keytar` shim).
- Replay nonce store on proxy.
- Project log file with rotation.
- `pact wallet rotate` command.
- Cross-compile windows-x64 + darwin-x64 + linux-arm64 binaries.

What slips to Saturday (mainnet floor):

- Mainnet whitelist flip.
- Second-pair security review of `lib/wallet.ts` and `lib/transport.ts`.

## 15. Testing strategy

### Unit tests (`packages/cli/test/`)

- `discovery.test.ts` — hostname matching, cache TTL behavior, error-driven invalidation
- `envelope.test.ts` — every status maps to right exit code, JSON shape stable
- `policy.test.ts` — auto-deposit cap edges (under/equal/over, session vs per-deposit)
- `transport.test.ts` — retry behavior on 4xx vs 5xx, timeout, signature construction
- `wallet.test.ts` — load/create, file mode validation, env override, keypair round-trip
- `project.test.ts` — four-tier resolution priority

### Integration tests

- Run a mock `market.pactnetwork.io` proxy via Hono in-process; CLI hits it.
- Cover: full happy path, `needs_funding`, `endpoint_paused`, `no_provider`, `signature_rejected`, retry on 5xx, cache invalidation on 410.

### Skill activation tests

Manually verify with Claude Code:

- Skill activates on `api.helius.xyz` URL.
- Skill does NOT activate on `localhost:3000` URL.
- Skill does NOT activate on `jsonplaceholder.typicode.com` URL (free public).
- After `pact init`, `CLAUDE.md` reinforces the matcher in subsequent sessions.

## 16. Open product questions (answer before Friday)

These don't block Wed but need resolving before the wider Friday ship:

1. **Faucet flow on devnet:** the Circle USDC faucet has a daily rate limit. If a fresh project hits it, then a second project on the same machine hits it ten minutes later, the second can fail. Mitigation: tell Claude in SKILL.md to fall back to manual instructions if faucet returns 429.
2. **Mainnet onboarding:** when an agent first hits `needs_funding` on mainnet, what's the lowest-friction deposit path? Dashboard URL with `?prefill_amount=5&wallet=<pubkey>` is the current plan. Confirm by Friday.
3. **Provider hostname allowlist drift:** the explicit list in SKILL.md frontmatter will go stale every time a new provider is onboarded. Plan: monthly script that generates SKILL.md from the live `/.well-known/endpoints` response. Friday's regen.
4. **Telemetry:** `X-Pact-Project` header attribution is in the design but we have no consumer for it yet. Indexer should log it; dashboard should expose per-project spend stats. Friday.

## 17. Risk register

| Risk | Mitigation |
|---|---|
| Bun-compile breaks on a transitive native dep | Stick to `@solana/kit` (pure JS) and Bun's native fetch. Test cross-compile in CI from day one. |
| Skill matcher misfires (Claude picks curl over pact for known hostname) | Belt-and-suspenders: explicit hostname list in SKILL.md frontmatter + project-pinned `CLAUDE.md` snippet via `pact init` + automated activation tests. |
| Devnet faucet rate limit blocks a demo retry | Manual fallback in SKILL.md; pre-fund the demo wallet before going on stage. |
| Proxy goes down mid-demo | Pre-stage a local proxy on `localhost:8080` and a `PACT_GATEWAY_URL` env override. Single env-var swap recovers. |
| Wallet file accidentally committed to git | `.gitignore` template bundled with `pact init`; CLI warns if `wallet.json` is inside a git repo. |
| Auto-deposit loop hits the cap mid-demo | The cap is the feature, not the bug. SKILL.md instructs Claude to surface the `auto_deposit_capped` envelope cleanly to the human. Demo scene survives. |
| `tx_signature: null` confuses live audience | Side terminal running `pact agents show --watch` shows settlement landing 5-10s after each call. Audience sees the loop close. |

## 18. Done definition

For Wed devnet ship to count as "shipped, real product":

- [ ] All 7 commands work end-to-end against devnet.
- [ ] All 11 statuses returned correctly under their corresponding test scenarios.
- [ ] Bun binary cross-builds for at least darwin-arm64 + linux-x64.
- [ ] `pact init` installs SKILL.md + writes CLAUDE.md snippet idempotently.
- [ ] An end-to-end Claude Code session demonstrates: cold start → `pact <url>` → `needs_funding` → `pact deposit 5` → `pact <url>` succeeds → `pact agents show` lists the call → `pact agents show --watch` shows settlement landing.
- [ ] All unit and integration tests pass.
- [ ] README documents install, usage, and the demo flow.
- [ ] CLI versioned `0.1.0`, published to npm, available via `npx @q3labs/pact-cli`.

For Friday harden to count as "production-grade":

- [ ] OS keychain integration on macOS, Linux, Windows.
- [ ] Replay nonce store live on proxy.
- [ ] `pact wallet rotate` shipped.
- [ ] Project log file + 7-day rotation.
- [ ] All five platform binaries built and signed.

For Saturday mainnet to count as "safe to flip":

- [ ] Second-pair security review signed off.
- [ ] Mainnet whitelist flag flipped in build.
- [ ] $200 mainnet pool seeded with hot key in Secret Manager.
- [ ] Smoke test of `pact <url>` against one mainnet provider with $1 budget.
