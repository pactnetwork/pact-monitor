# Multi-EVM WP — Task 1 Report (chain-scoped deployment env keys)

**Branch:** `feat/concurrent-multi-evm`
**Commit:** `5d18ecf` — `feat(protocol-evm-v1-client): chain-scope deployment env keys (multi-evm WP T1)` (5 files, +117 / -13)
**Status:** DONE. Concurrency-gate assertion 1 now GREEN; assertion 3 stays RED (Task 2). No regressions.

## Impact analysis

GitNexus has no index for `pact-network` (only OnePlanApp/brove/claude-cockpit
are indexed), so the blast radius was traced manually. `resolveDeployment`
dependents (d=1, WILL BREAK on a signature change), all in-workspace:

- `packages/settler/src/adapters/adapters.service.ts` (call site)
- `packages/indexer/src/adapters/adapters.service.ts` (call site)
- `packages/market-proxy/src/lib/context.ts` (call site)
- `packages/protocol-evm-v1-client/__tests__/addresses.test.ts` (4 tests on the 2-arg signature)

The T0 concurrency gate uses `resolveDeployment` only INDIRECTLY (via
`AdaptersService`), so its signature change does not touch the gate file — and
the gate was NOT modified (hard rule honored).

## Signature change + precedence

`resolveDeployment` gained a `network` identity (a plain string, NOT a
`ChainDescriptor` — `protocol-evm-v1-client` must not import from
`@pact-network/shared`, which would be circular):

```
- resolveDeployment(chainId: number, env = process.env)
+ resolveDeployment(chainId: number, network: string, env = process.env)
```

Per-address (registry/pool/settler) resolution precedence, highest first:

1. **per-chain key** `PACT_EVM_<KIND>_<NETWORK_UPPER>` (multi-EVM scoping)
2. **legacy global** `PACT_EVM_<KIND>` (single-EVM-chain backward compat)
3. **baked value** `DEPLOYMENTS[chainId][kind]`

where `NETWORK_UPPER = network.replace(/-/g, "_").toUpperCase()` — the SAME
suffix convention `adapters.service.ts` uses for keypair/rpc keys. Documented in
the `resolveDeployment` doc-comment. A bad address reports the actual key that
supplied it (per-chain vs global) for operator debugging.

This matches the suffix the T0 gate committed to: `arc-testnet -> ARC_TESTNET`,
`evm-test-2 -> EVM_TEST_2`.

## Call-site updates (network identity threaded)

All three pass the loop's network name (`name`) as the new 2nd arg:

- `settler/src/adapters/adapters.service.ts`: `resolveDeployment(descriptor.chainId, name, process.env)`
- `indexer/src/adapters/adapters.service.ts`: `resolveDeployment(descriptor.chainId, name, process.env)`
- `market-proxy/src/lib/context.ts`: `resolveDeployment(descriptor.chainId, name, processEnv as ...)`

## Backward-compat test results

`packages/protocol-evm-v1-client/__tests__/addresses.test.ts` — **9/9 pass**.
New `resolveDeployment — chain-scoped env overlay (multi-evm WP T1)` block:

- (a) per-chain key wins over the legacy global key — PASS
- (b) legacy global key still applies when no per-chain key is set — PASS
- (c) baked DEPLOYMENTS value used when neither key is set — PASS
- suffix derived from network name (dashes -> underscores, uppercased; wrong-suffix key ignored) — PASS
- per-kind independence (per-chain registry + global pool + baked settler) — PASS

Existing tests retained (updated to the 3-arg signature): legacy-global overlay,
malformed-address rejection, baked Arc constants, `getDeployment` throw-on-unknown.

So the live single-chain Arc deploy still resolves correctly via BOTH the baked
value (case c) and the legacy global `PACT_EVM_REGISTRY` (case b) — no regression.

## Before/after gate counts

| Suite | Before T1 | After T1 |
|---|---|---|
| `multi-evm-concurrency` gate | 2 passed / 2 failed (assertion 1 + 3 RED) | **3 passed / 1 failed** (only assertion 3 RED) |
| assertion 1 (distinct addresses) | RED | **GREEN** |
| assertion 3 (parallel/isolation) | RED (Task 2) | RED (Task 2) — unchanged, expected |
| `protocol-evm-v1-client` addresses unit | 4 passed | **9 passed** |
| `arc-testnet-settle-e2e` | 8/8 | **8/8** (no regression) |

## Build check

`pnpm --filter @pact-network/settler --filter @pact-network/indexer --filter
@pact-network/market-proxy build` — all three **build clean** (exit 0).
`protocol-evm-v1-client` rebuilt to `dist` so consumers pick up the new signature.

## Notes / scope discipline

- T0 gate test NOT modified. Assertion 1 went GREEN purely from the production
  fix (per-chain key wins over the global key the gate also sets).
- `gitnexus analyze` intentionally NOT run (worktree gotcha per `CLAUDE.md`).
- No emojis; pnpm only.
- Assertion 3 remains RED by design — it is Task 2 (parallel settler flush).
