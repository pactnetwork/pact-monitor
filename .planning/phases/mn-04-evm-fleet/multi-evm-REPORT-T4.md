# Multi-EVM WP — Task 4 Report (EVM signer gas-balance monitoring)

**Branch:** `feat/concurrent-multi-evm`
**Commit:** `5816266` — `feat(settler,shared): per-network EVM signer gas-balance monitoring (multi-evm WP T4)` (5 files, +342 / -12)
**Status:** DONE. Per-network EVM signer gas monitoring added alongside the unchanged Solana check; zero regressions.

## STOP-AND-ASK (design fork, as the task flagged)

Paused via `AskUserQuestion` before coding the threshold. Your answers:
- **Threshold source:** chain-scoped env + baked default —
  `PACT_EVM_GAS_<WARN|CRIT>_WEI_<NETWORK_UPPER>` -> global
  `PACT_EVM_GAS_<WARN|CRIT>_WEI` -> baked default (0.01 / 0.003 native token =
  `1e16` / `3e15` wei, parallel to the SOL thresholds). Mirrors T1's
  chain-scoped env convention.
- **Health gating:** warn/alert only (log + Prometheus gauge); a low EVM balance
  does NOT flip the settler `/health` to 503 (one underfunded EVM chain must not
  deroute the whole settler).

## Impact analysis (manual — GitNexus has no pact-network index)

- `SignerBalanceService` constructor gained a 3rd dep (`AdaptersService`) — d=1
  dependents = its own spec (10 construction sites) + the DI module
  (`health.module.ts`). Both updated; no other caller constructs it.
- `ChainAdapter` gained an OPTIONAL `getNativeBalance?` — additive, so existing
  implementors (SolanaAdapter) and consumers/mocks are unaffected.

## The change

**shared (`@pact-network/shared`):**
- `ChainAdapter`: added optional `getNativeBalance?(address): Promise<bigint>`.
- `EvmAdapter.getNativeBalance(address)`: reads native gas balance via the real
  viem public client (`this.publicClient.getBalance({ address })`) — no
  hand-rolled RPC. SolanaAdapter does not implement it.

**settler `SignerBalanceService`:**
- Injects `AdaptersService` (HealthModule now imports `AdaptersModule`).
- `poll()` now runs `pollSolana()` (the existing logic, extracted verbatim) AND
  `pollEvmSigners()`. They are independent: an EVM RPC failure doesn't affect the
  Solana result, and a missing Solana keypair (EVM-only deploy) no longer skips
  the EVM checks.
- `pollEvmSigners()`: for each enabled network where `descriptor.vm === "evm"`
  and the adapter implements `getNativeBalance`, resolve the signer via
  `AdaptersService.getEvmAccount(network)` (skip gracefully if it throws —
  read-only deploy), read the balance, classify ok/warn/crit against the
  resolved thresholds, set the per-network gauge, and log at the matching level.
  Per-network isolated: a missing signer or RPC failure is logged and skipped,
  never thrown.
- New Prometheus gauge `settler_evm_signer_gas_native{network}` (native-token
  float; wei avoided for the gauge because 1e16 > Number.MAX_SAFE_INTEGER, but
  threshold comparisons stay in `bigint` wei for precision).
- New constants `EVM_GAS_WARN_WEI` (1e16) / `EVM_GAS_CRIT_WEI` (3e15);
  `resolveEvmGasThreshold(network, kind)` implements the env precedence.
- Accessors `getEvmSignerState(network)` / `listEvmSignerNetworks()` expose the
  last observed `{ wei, status }` for tests/ops.

## Test results (TDD: RED first)

`packages/settler/src/health/signer-balance.service.spec.ts` — **18/18 pass**
(6 new EVM tests; the 12 existing Solana/HealthController tests updated to the
3-arg constructor with an empty-adapter stub and stay green).

New EVM tests:
- checks each enabled EVM signer's native balance and records status by
  threshold (arc 0.02 -> ok; evm-test-2 0.001 -> crit; solana untracked).
- flags 'warn' between CRIT and WARN (0.005 native).
- still runs the Solana balance check unchanged.
- skips an EVM network with no loaded signer (read-only) without throwing.
- honors a chain-scoped gas threshold env override
  (`PACT_EVM_GAS_WARN_WEI_ARC_TESTNET`).
- does not let an EVM balance RPC failure throw out of `poll()` (Solana result
  still recorded).

RED proof before impl: `5 failed | 13 passed` — the 5 EVM tests calling
`getEvmSignerState` failed (`not a function`); the Solana-unchanged EVM test and
all 12 existing tests passed. After impl: 18/18.

## Full settler suite proof (gate 4/4, Arc 8/8)

`pnpm --filter @pact-network/settler test`:

```
 Test Files  14 passed (14)
      Tests  98 passed (98)
```

(was 92 -> 98 with the 6 new EVM tests). Includes `multi-evm-concurrency` gate
**4/4**, `arc-testnet-settle-e2e` **8/8**, batcher, submitter, indexer-pusher,
adapter-swap/pipeline Solana guards — all green.

- `shared` full suite **39/39** (contract/parity guards green;
  `getNativeBalance` is additive/optional).
- Builds clean: `shared` + `settler` (`nest build`), exit 0.

## Notes / scope discipline

- Did NOT modify the gate test or any T0-T3/T6 code. The Solana
  `pollSolana()` body is the original logic, extracted unchanged.
- viem `getBalance` via the adapter's public client — no hand-rolled RPC.
- `gitnexus analyze` intentionally NOT run (worktree gotcha per `CLAUDE.md`).
- No emojis; pnpm only.
- With T4 done, the crew-1 multi-EVM tasks are T0, T1, T2, T3, T4, T6. T5
  (settler EVM-only boot) is the remaining unassigned task.
