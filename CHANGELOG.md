## Changelog

All notable changes to this repo land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the repo uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) per published package.

The repo is a workspace, so entries are grouped by package where it helps. Workspace-wide changes (CI, infra, gates) live under **Workspace**.

## [Unreleased]

### Added

- `packages/sdk/skills/pact-sdk/SKILL.md` — agent-skill teaching coding agents (Claude Code, Cursor, etc.) how to integrate `@q3labs/pact-sdk` into a project: install command, canonical fetch-replacement diff, signer cases, one-time `setup()` rules, B1 devnet/localnet caveat, and the golden-rule do-not-list. Mirrors the structure of `packages/cli/skills/pact-pay/SKILL.md`.

## 2026-05-20 — SDK 0.1.0 release

This is the first public release of the Pact Network agent SDK. The release PR (`develop` → `main`) is [#212](https://github.com/pactnetwork/pact-monitor/pull/212); on merge, `publish-sdk.yaml` publishes both packages to npm.

### Added

- `@q3labs/pact-sdk@0.1.0` — first release. Unified Pact Network agent SDK: `createPact()` returns a `pact.fetch()` that routes covered calls through the Pact Market proxy, manages the one-time global SPL approve, and surfaces typed events (`failure`, `refund`, `billed`, `low-balance`, `degraded`). Drop-in `fetch` replacement on Pact Network V1. Originally landed in [#210](https://github.com/pactnetwork/pact-monitor/pull/210).
- `@q3labs/pact-protocol-v1-client@0.2.0` — first publish under the `@q3labs` scope. TypeScript client for `pact-network-v1-pinocchio`: PDA derivers, account state decoders, instruction builders, SPL Token Approve/Revoke wrappers, fee-recipient helpers, error-code mapping, on-chain constants.
- `publish-sdk.yaml` GitHub Actions workflow. Two-step publish (protocol-client → sdk), `pnpm publish --dry-run` gating, monotonicity/idempotency guards, post-publish `npm view` verification with a 60s retry budget, and tag-after-verify ordering. Cuts a `sdk-v<version>` tag and a `gh release create` only after both packages resolve on the registry.
- Devnet Railway deploy scaffold — five services (`market-proxy`, `indexer`, `settler`, `dummy-upstream`, `facilitator`), env templates, smoke harness, and a runbook at `docs/devnet-railway-deploy.md` ([#202](https://github.com/pactnetwork/pact-monitor/pull/202)).
- Private beta gate — schema, backend, and `market-proxy` middleware ([#198](https://github.com/pactnetwork/pact-monitor/pull/198)).
- Redis Streams adapter for the proxy event sink and the settler consumer ([#199](https://github.com/pactnetwork/pact-monitor/pull/199)).
- SQL-first CRM layer on `beta_applicants` ([#208](https://github.com/pactnetwork/pact-monitor/pull/208)).
- Tally webhook integration — provisioner script and `why_pact` + `willing_to_feedback` capture ([#207](https://github.com/pactnetwork/pact-monitor/pull/207), [#203](https://github.com/pactnetwork/pact-monitor/pull/203)).
- Devnet on-chain init script with the USDC mint fix ([#205](https://github.com/pactnetwork/pact-monitor/pull/205)).
- PayAI-backed x402 settle for the dummy upstream ([#197](https://github.com/pactnetwork/pact-monitor/pull/197), reconciled via [#211](https://github.com/pactnetwork/pact-monitor/pull/211)).

### Changed

- npm scope rename: `@pact-network/*` → `@q3labs/*`. This aligns the SDK and protocol client with the rest of our publish surface (`@q3labs/pact-cli`, `@q3labs/pact-monitor`, `@q3labs/pact-insurance`). External callers must update both imports and `package.json` dependency entries.

### Removed

- Implicit devnet program ID default in `@q3labs/pact-protocol-v1-client`. The devnet deploy (`5jBQb7fL…`) is live for reads but its compiled `declare_id!` is the mainnet ID, so PDAs derived from `crate::ID` don't match the deploy address and `settle_batch` reverts `InvalidSeeds`. We will not ship a default that silently breaks settlement. On devnet and localnet, callers must pass `createPact({ programId })` explicitly. Mainnet still uses the canonical default `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc`. This is the "B1" caveat — see the SDK README's *Operator notes* section.

### Notes

- `@q3labs/pact-sdk` is ESM-only. Node ≥18 for the package; browser via any ESM bundler (Vite, Webpack 5, esbuild, Rollup). There is no CJS export.
- `apiKey` on `PactConfig` is reserved and currently unused — the Pact Market proxy authenticates via ed25519 request signatures, not a bearer key.
