# Curated Endpoints Wiring — REPORT

Date: 2026-05-29
Branch: `chore/curated-endpoints-moralis-covalent` (off `feat/multi-network`)
PR: **#247** → https://github.com/pactnetwork/pact-monitor/pull/247 (base `feat/multi-network`)

## Objective

Make curated providers **moralis** + **covalent** first-class across the codebase (code wiring),
then draft an on-chain/DB registration plan for Rick.

## PART 1 — Upstream URL verification (current, 2026-05-29)

| provider | canonical base | auth | verdict |
|----------|----------------|------|---------|
| moralis | `https://deep-index.moralis.io` (callers append `/api/v2.2/…`) | `X-API-Key` header | ✅ current, matches expected |
| covalent | `https://api.covalenthq.com` (callers append `/v1/…`) | `Authorization: Bearer` | ✅ current; rebranded to **GoldRush** but `api.covalenthq.com` is still the canonical base |

Verified via web search against current Moralis and GoldRush/Covalent docs. No base-URL change vs the
expected values — used as-is.

## PART 2 — Code wiring (committed)

Commit `f9a9e23` — `chore(shared,indexer): add moralis+covalent to curated endpoint catalog`.

Files changed (3):
- `packages/shared/src/slugs.ts` — `ENDPOINT_SLUGS` → 7 production curated (`helius, birdeye, jupiter, elfa, fal, moralis, covalent`). `dummy` + `pay-default` kept OUT.
- `packages/indexer/src/sync/on-chain-sync.service.ts` — `DEFAULT_UPSTREAM_BASE` += `moralis: https://deep-index.moralis.io`, `covalent: https://api.covalenthq.com` (with auth-model comments, matching existing entry style).
- `packages/indexer/test/on-chain-sync.service.spec.ts` — former "five endpoints" loop test → 7-provider curated set + asserts each resolves its default `upstreamBase` (covers the new map entries).

### Already-present proxy maps (verified, no change needed)
- `packages/market-proxy/src/lib/registry.ts` — `handlerRegistry` already has moralis + covalent (handlers `moralis.ts`, `covalent.ts` exist).
- `packages/market-proxy/src/lib/classifiers.ts` — `classifierRegistry` already has both (static `marketDefaultClassifier`).
- `packages/market-proxy/src/lib/hostnames.ts` — `PROVIDER_HOSTNAMES` already lists `deep-index.moralis.io` and `api.covalenthq.com` (+ `api.goldrush.dev`).

No production-curated provider was missing from any proxy map. `pay-default` correctly NOT in proxy
(facilitator-only); `dummy` retained in proxy maps but excluded from `ENDPOINT_SLUGS` as intended.

## Impact analysis (gitnexus unavailable → manual)

gitnexus `impact` / `detect_changes` could **not** run: `pact-network` is not present in this machine's
gitnexus MCP index (available repos: OnePlanApp, brove, claude-cockpit, pact-monitor). Manual
blast-radius assessment via grep:

- **`ENDPOINT_SLUGS`** — exported from `@pact-network/shared` but has **zero code consumers** (no
  imports anywhere; `events.service.ts` uses a local `sortedEndpointSlugs` var, unrelated). Change is
  purely additive: widens the `as const` tuple and the derived `EndpointSlug` union. **Risk: LOW.**
- **`DEFAULT_UPSTREAM_BASE`** — module-private const in `on-chain-sync.service.ts`, read at exactly 2
  sites (lines 272, 423) as `DEFAULT_UPSTREAM_BASE[slug] ?? ""`. Adding keys only changes which slugs
  get a non-empty default upstreamBase on first create. **Risk: LOW.**

Scope confirmed via `git diff --stat`: only the 3 intended files; no agent-doc (CLAUDE.md/AGENTS.md) drift.

## Test results

| package | build | tests |
|---------|-------|-------|
| @pact-network/shared | ✅ | 53/53 pass |
| @pact-network/indexer | ✅ | 141/141 pass (incl. updated curated-endpoints spec) |
| @pact-network/market-proxy | ✅ | 173/173 pass |

(Benign `bigint: Failed to load bindings` warnings and one caught `AppContext not initialized` inside a
passing test — pre-existing, not introduced here.)

## PART 3 — Registration plan

Written to `.planning/endpoint-registration-plan.md` (deliverable for Rick; NOT executed, NOT in the
code PR). Covers, per the 7 curated providers, split into Rick-block (mainnet/prod perms) vs
local/testnet-block:
- Step A: exact `register_endpoint` (Solana, `protocol-v1-client`) + `registerEndpoint` (EVM,
  `protocol-evm-v1-client` + PactRegistry ABI) shapes, args, accounts, authorities, per-network table
  (solana-mainnet 5bCJ, solana-devnet 5jBQ incl. FS9 caveat, arc-testnet, base-sepolia).
- Step B: `Endpoint` DB row (composite PK `(network, slug)`), `DEFAULT_UPSTREAM_BASE` auto-fill of
  `upstreamBase`, seed shape reference.
- Step C: provider secrets + exact env var names from handlers (only `PACT_HELIUS_API_KEY` is wired
  today; elfa/fal injection is a flagged code TODO; jupiter keyless).
- Step D: premium + fee-recipient values flagged as a product decision (reference dummy/helius:
  flatPremiumLamports 1000, percentBps 0).

## Constraints honored

No on-chain txs · no DB writes · no mainnet · no direct push to `feat/multi-network` (PR only).
