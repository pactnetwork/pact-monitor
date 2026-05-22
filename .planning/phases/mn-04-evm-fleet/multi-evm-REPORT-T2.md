# Multi-EVM WP — Task 2 Report (parallel settler flush)

**Branch:** `feat/concurrent-multi-evm`
**Commit:** `3878428` — `fix(settler): parallelize batcher flush across (network,slug) groups (multi-evm WP T2)` (2 files, +71)
**Status:** DONE. Concurrency gate **4/4 GREEN** (assertion 3 closed). Zero regressions.

## Impact analysis

GitNexus has no `pact-network` index; blast radius traced manually.
`BatcherService.flush()` dependents (d=1):

- `pipeline.service.ts` — `setFlushCallback` wires `onFlush` (= `runTrackedBatch
  -> processBatch`); `flushNow()` calls `flush()` (awaited in `onModuleDestroy`
  with try/catch).
- `batcher.service.spec.ts`, `multi-evm-concurrency.spec.ts`,
  `arc-testnet-settle-e2e.spec.ts` — call `flush()` directly.

Behavior change: `flush()` now dispatches groups concurrently and RESOLVES even
when a group rejects (it logs the rejection rather than throwing). This is also
safer for the existing fire-and-forget callers in `push()` (`void this.flush()`
and the 5s timer), which previously could surface an unhandled rejection.

## Flush-loop diff

Before (serial — head-of-line-blocking at `batcher.service.ts:96-102`):

```ts
for (const key of order) {
  const messages = groups.get(key)!;
  this.logger.log(`Flushing batch of ${messages.length} events`);
  if (this.onFlush) {
    await this.onFlush({ messages });   // one slow/hung group blocks the rest
  }
}
```

After (concurrent + isolated):

```ts
const cb = this.onFlush;
if (!cb) return;

const results = await Promise.allSettled(
  order.map((key) => {
    const messages = groups.get(key)!;
    this.logger.log(`Flushing batch of ${messages.length} events`);
    return cb({ messages });
  }),
);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.status === "rejected") {
    this.logger.error(
      `Flush group "${order[i]}" failed (isolated from siblings): ${r.reason}`,
    );
  }
}
```

Preserved invariants:
- **Order within a group:** each group's `messages` array keeps its insertion
  order; only dispatch ACROSS groups is parallelized.
- **Single-network-per-group (finding 4):** the `(network, slug)` partition that
  builds `groups`/`order` is unchanged — `Promise.allSettled` maps over the same
  `order`.

## How failure-isolation / nack-per-group works

- Each group is one batch passed to `onFlush` = `PipelineService.runTrackedBatch
  -> processBatch`. `processBatch` already nacks ITS OWN batch on submit/index
  failure: it catches `BatchSubmitError` -> `this.consumer.nack(batch.messages)`
  and returns; `IndexerPushError` likewise nacks that batch's messages. So a
  group's failure redelivers only that group's Pub/Sub messages.
- `Promise.allSettled` runs all groups to completion regardless of any one
  rejecting/hanging, so a sibling's failure cannot abort the others.
- Any rejection that escapes `processBatch` (e.g. an unexpected non-
  `BatchSubmitError` such as a finality timeout) is SURFACED via
  `logger.error(... isolated from siblings ...)` — not swallowed — and does not
  reject `flush()` (so the timer/size-trigger `void this.flush()` callers stay
  clean).

## Concurrency bound

Concurrency equals the number of distinct `(network, slug)` pairs in a single
flush — small in practice (a handful of chains x slugs, and `MAX_BATCH_SIZE = 3`
caps events per group). No explicit cap added; adding one would be premature
complexity. If a future high-fan-out fleet (many slugs x many chains per flush)
emerges, revisit with a bounded pool — noted here rather than added silently.

## Before/after gate counts

| Suite | Before T2 | After T2 |
|---|---|---|
| `multi-evm-concurrency` gate | 3 passed / 1 failed (assertion 3 RED) | **4 passed / 0 failed** |
| assertion 3 (parallel/isolation) | RED | **GREEN** (chain B settles in 2506ms-run while A hangs 2500ms; B well under the 1000ms bound) |
| `batcher.service.spec` | 6 passed | **8 passed** (2 new T2 tests: concurrent dispatch + reject-isolation) |

The gate test was NOT modified — assertion 3 went green purely from the
production fix. The wide timing margin (B in tens of ms vs the 1000ms bound, A
hanging 2500ms) is preserved, so no timing flakiness.

## Full settler suite proof + Arc e2e

`pnpm --filter @pact-network/settler test`:

```
 Test Files  14 passed (14)
      Tests  92 passed (92)
```

Includes (no regression):
- `arc-testnet-settle-e2e.spec.ts` — **8/8** (mixed-network + mixed-slug
  partition tests green).
- `multi-evm-concurrency.spec.ts` — **4/4**.
- `batcher.service.spec.ts` — **8/8**.
- `submitter.service.spec.ts`, `indexer-pusher.service.spec.ts`,
  `secret-loader.service.spec.ts`, and the Solana guards
  (`adapter-swap-e2e.spec.ts`, `pipeline.e2e.spec.ts`,
  `arc-testnet-routing.spec.ts`) — all green.

`pnpm --filter @pact-network/settler build` — clean (exit 0).

## Notes / scope discipline

- New unit tests added in `batcher.service.spec.ts` (TDD: RED first — 2 failing,
  then GREEN). Gate test untouched.
- `gitnexus analyze` intentionally NOT run (worktree gotcha per `CLAUDE.md`).
- No emojis; pnpm only.
- The three concurrency-gap closers (T1 env scoping, T2 parallel flush) are now
  done; T3-T6 (indexer cursor, EVM balance monitoring, Solana-optional boot,
  legacy-network fix) remain.
