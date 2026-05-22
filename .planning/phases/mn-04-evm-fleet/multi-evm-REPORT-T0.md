# Multi-EVM WP — Task 0 Report (RED acceptance gate)

**Branch:** `feat/concurrent-multi-evm`
**Commit:** `eececea` — `test(settler): add failing two-EVM-chain concurrency acceptance gate (multi-evm WP T0)`
**Status:** RED on the right reasons. Committed. STOPPED (no fixes; Tasks 1-6 not started).

## File created

`packages/settler/test/multi-evm-concurrency.spec.ts` (568 lines, 1 file changed, 568 insertions).

Bootstraps ONE settler with `PACT_ENABLED_NETWORKS="arc-testnet,evm-test-2"`, each
EVM chain given its OWN registry/pool/settler addresses, and asserts end-to-end:

1. **Distinct deployments** — the two `EvmAdapter`s resolve DIFFERENT
   registry/pool/settler addresses. RED today.
2. **Both settle** — a flush with a batch per chain runs the REAL
   `submitSettleBatch` on BOTH adapters, each encoding its own chain's
   `settleBatch` calldata with a `0x` bytes16 callId from a real UUID. GREEN
   (harness sanity).
3. **Parallel + isolated** — chain A's finality poll hangs 2500ms; chain B's
   settlement must complete in < 1000ms, proving it did NOT wait serially behind
   A. RED today.
4. **No cross-talk** — each chain uses its own signer + its own adapter instance;
   no shared mutable state. GREEN (guard).

### Synthetic-chain injection (kept out of the prod registry)

- `getChain()` is overlaid for `evm-test-2` only (chainId 999999, distinct RPC
  host `http://evm-test-2.local`) via `vi.mock("@pact-network/shared", …)` with
  `importOriginal` spread — the real `EvmAdapter`/`SolanaAdapter`/everything else
  is preserved; only the descriptor lookup is injected.
- A test-scoped `DEPLOYMENTS[999999]` base entry (registry/pool/settler `null`)
  is added in `beforeEach` and `delete`d in `afterEach`. `chains.json` and the
  source `DEPLOYMENTS` map are never edited.
- `resolveDeployment` is left REAL (never mocked) — assertion 1 depends on
  exercising the real global-vs-per-chain overlay.

### Per-chain env-key scheme this gate commits Task 1 to

`PACT_EVM_<REGISTRY|POOL|SETTLER>_<NETWORK_UPPER>` where
`NETWORK_UPPER = network.replace(/-/g, "_").toUpperCase()` (matches
`adapters.service.ts`'s keypair/rpc convention): `arc-testnet -> ARC_TESTNET`,
`evm-test-2 -> EVM_TEST_2`. The test sets BOTH the global keys
(`PACT_EVM_REGISTRY/POOL/SETTLER` — the collision source, RED today) and the
per-chain keys (inert today; the GREEN target after Task 1).

## Exact RED output

```
 ❯ test/multi-evm-concurrency.spec.ts (4 tests | 2 failed) 2548ms
   × multi-evm WP T0 … > resolves DISTINCT per-chain registry/pool/settler addresses for the two EVM chains 27ms
     → expected '0x125dE134Def4Dcf87E777584C5B5C189f1b…' not to be '0x125dE134Def4Dcf87E777584C5B5C189f1b…' // Object.is equality
   × multi-evm WP T0 … > isolates a hung chain: chain B settles in parallel without waiting behind chain A 2507ms
     → expected 2504 to be less than 1000

 FAIL  … > resolves DISTINCT per-chain registry/pool/settler addresses for the two EVM chains
AssertionError: expected '0x125dE134…' not to be '0x125dE134…' // Object.is equality
 ❯ test/multi-evm-concurrency.spec.ts:488:30
    488|     expect(arc.registry).not.toBe(b.registry);

 FAIL  … > isolates a hung chain: chain B settles in parallel without waiting behind chain A
AssertionError: expected 2504 to be less than 1000
 ❯ test/multi-evm-concurrency.spec.ts:545:24
    545|       expect(bElapsed).toBeLessThan(B_BOUND_MS);

 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
```

**Why these are the RIGHT reasons (not a harness artifact):**

- Assertion 1 fails because `arc.registry === b.registry` — both EVM chains
  received the SAME `PACT_EVM_REGISTRY` global override. This is the
  env-collision gap (`addresses.ts` `resolveDeployment` reads global keys only;
  `adapters.service.ts:69` passes `process.env`). Closed by Task 1.
- Assertion 3 fails with `bElapsed = 2504ms ≈ ARC_HANG_MS (2500)` — chain B did
  not start until chain A's hung finality completed. This is the serial
  head-of-line-blocking gap at `batcher.service.ts:96-102` (`for … await
  onFlush`). Closed by Task 2.
- Assertions 2 and 4 PASS, proving the REAL seam is wired (both adapters run the
  real `submitSettleBatch` + real `encodeSettleBatch`; per-chain signers already
  isolated). So the RED is a real gap, not a wiring artifact.

## Proof the test mocks neither the settle seam nor the flush loop

```
$ grep -nE "submitSettleBatch|encodeSettleBatch" packages/settler/test/multi-evm-concurrency.spec.ts
24: *     calldata encoder (encodeSettleBatch), the real resolveDeployment overlay.
27: *     queue/indexer/Solana egress. NOTHING here replaces submitSettleBatch,
28: *     encodeSettleBatch, or the batcher flush loop — those are the seam under
394:  // processBatch -> submitter.submit -> adapter.submitSettleBatch.
494:  // chain invokes the REAL submitSettleBatch on BOTH adapters, each running the
```

All matches are COMMENTS — `submitSettleBatch`/`encodeSettleBatch` are never
mocked, spied, or replaced.

```
$ grep -nE "vi\.mock|vi\.spyOn" packages/settler/test/multi-evm-concurrency.spec.ts
154:vi.mock("@pact-network/shared", …)   # getChain registry injection ONLY (EvmAdapter preserved)
178:vi.mock("@solana/web3.js", …)        # Connection egress (Solana boot read)
190:vi.mock("axios");                    # indexer-push egress

$ grep -nE "flush|setFlushCallback" packages/settler/test/multi-evm-concurrency.spec.ts
503:    await batcher.flush();           # REAL BatcherService.flush()
540:      const flushPromise = batcher.flush();
```

No `vi.spyOn`. The only mocks are the synthetic-chain registry lookup and
network/storage egress (Solana RPC, axios, viem `fetch`). The flush is the real
`BatcherService.flush()`; the flush callback is wired by the real
`PipelineService.onModuleInit()` (`batcher.flush -> runTrackedBatch ->
processBatch -> submitter.submit -> adapter.submitSettleBatch`).

## How assertion 3's parallelism/isolation was proven

- TWO real `EvmAdapter`s share the global `fetch` stub, routed per chain by RPC
  host (`evm-test-2.local` vs `rpc.testnet.arc.network`), so each chain answers
  JSON-RPC independently.
- Chain A's `eth_getTransactionReceipt` (the finality-confirmation poll inside
  `EvmAdapter.submitSettleBatch`'s D6 §5.1 wait-loop) is delayed
  `ARC_HANG_MS = 2500ms`; chain B's RPC is all-instant.
- Chain A is pushed into the batcher FIRST (insertion order is preserved by the
  `(network,slug)` partition), so the serial loop processes A's group before B's.
- A deferred `bSettledPromise` resolves when chain B's finality poll is answered;
  the test records `bSettledAt` and measures `bElapsed = bSettledAt - t0` where
  `t0` is captured immediately before `batcher.flush()`.
- Today (serial `for … await`): B cannot start until A's full 2500ms settlement
  completes, so `bElapsed ≈ 2504ms` > 1000ms bound → RED.
- After Task 2 (parallel flush): B confirms while A is still hanging, so
  `bElapsed` is tens of ms < 1000ms → GREEN. The 2500-vs-1000 margin is large to
  avoid flakiness; the test then awaits `flushPromise` so A's in-flight work is
  drained (no dangling promises).

## Regression check

- `arc-testnet-settle-e2e.spec.ts`: **8/8 passed** (new file does not touch
  source; no regression).

## Notes / scope discipline

- No production source changed (Task 0 is the gate only). Tasks 1-6 NOT started.
- `gitnexus analyze` intentionally NOT run (worktree gotcha per `CLAUDE.md`).
- Run command: `pnpm --filter @pact-network/settler exec vitest run multi-evm-concurrency`.
