# Review #226 — FIX F1 (timestamp parity) — REPORT

**Status:** DONE (BLOCKING finding resolved)
**Branch:** `feat/concurrent-multi-evm`
**Commit:** `4f54244` — `fix(settler,shared): encode canonical wrapped-call timestamp in adapter settle path (review #226 F1)`

---

## Rick's finding (verbatim)

> The adapter path drops the canonical event timestamp. Legacy Solana direct
> settlement parses the queued event's `ts` via `parseEventTimestamp()` and
> writes that into the on-chain call record. Both adapter paths instead
> synthesize `Date.now()` at submit time (shared/src/adapters/evm/index.ts
> ~395/408; shared/src/adapters/solana/index.ts:241). So EVM
> `CallSettled.timestamp` and Solana adapter-path `CallRecord.timestamp` record
> settler-EXEC time, not the wrapped call time.

## Root cause

- `submitViaAdapter()` built per-event `SettleBatchInput.events[]` WITHOUT a
  timestamp; the field did not exist on the interface.
- `EvmAdapter.submitSettleBatch` computed `const now = BigInt(Math.floor(Date.now()/1000))` and encoded `timestamp: now`.
- `SolanaAdapter.submitSettleBatch` encoded `timestamp: BigInt(Math.floor(Date.now()/1000))`.
- Only the legacy-direct path (`submitter.service.ts:461,482`) used the canonical
  `ts = parseEventTimestamp(d)`.

## Fix — mirrors the finding-6 `refundBaseUnits` threading pattern exactly

`eventTimestamp` was threaded through the same three seams `refundBaseUnits` was:

1. **Interface** — `packages/shared/src/chain-adapter.ts`
   Added VM-neutral `eventTimestamp?: bigint` (unix seconds) to
   `SettleBatchInput.events[]`, alongside `refundBaseUnits`. Optional for
   backward compat; adapters fall back to the submit-time clock when unset.

2. **Settler** — `packages/settler/src/submitter/submitter.service.ts`
   `submitViaAdapter()` now populates `eventTimestamp: BigInt(parseEventTimestamp(d))`
   — the **same** `parseEventTimestamp(d)` the legacy-direct path uses
   (`submitter.service.ts:461`). `parseEventTimestamp` returns unix seconds
   (number); wrapped in `BigInt()` for the VM-neutral wire field.

3. **Both adapters** encode the supplied value instead of `Date.now()`:
   - `shared/src/adapters/evm/index.ts` — `timestamp: e.eventTimestamp ?? now`
   - `shared/src/adapters/solana/index.ts` — `timestamp: e.eventTimestamp ?? BigInt(Math.floor(Date.now()/1000))`

## Tests (TDD — RED written first, watched fail, then GREEN)

### 1. EVM calldata-decode (real seam) — `arc-testnet-settle-e2e.spec.ts`
New test `encodes the queued event ts as the on-chain timestamp, not the
settler-exec Date.now() (F1)`. Extends the existing real-seam e2e: the message
`ts` (`2020-01-02T03:04:05.000Z`) threads through the REAL `submitViaAdapter` →
REAL `EvmAdapter` → REAL protocol-evm-v1-client calldata encoder. The broadcast
calldata is decoded and `event.timestamp` is asserted to equal the queued ts
(`1577934245n`), and asserted **not** equal to submit-time `Date.now()`. The
encode seam is NOT mocked.
- **RED:** `expected 1779444124n to be 1577934245n` (adapter used Date.now()).
- **GREEN:** passes.

### 2. Solana adapter parity — `solana-adapter-parity.test.ts`
New test `submitSettleBatch encodes the supplied eventTimestamp, not Date.now()
(Rick #226 F1)`. `buildSettleBatchIx` is captured (short-circuits before the
real send) and the per-event `timestamp` it receives is asserted to equal the
supplied `eventTimestamp` (`1577836800n`), not `Date.now()`. Mirrors the sibling
arc-e2e mock style.
- **RED:** `expected 1779444116n to be 1577836800n` (adapter used Date.now()).
- **GREEN:** passes.

## Before / after suite

| Suite | Before | After |
|---|---|---|
| Full settler suite | 107 passed | **108 passed** (+1 new F1 e2e test) |
| — multi-evm-concurrency gate | 4/4 green | 4/4 green (untouched) |
| Full shared suite | 39 passed | **40 passed** (+1 new Solana parity test) |
| `shared` build (`tsc`) | clean | clean |
| `settler` build (`nest build`) | clean | clean |

## Compliance with hard rules

- TDD RED-first: both new tests watched fail for the correct reason (Date.now()
  value received) before any production edit.
- `multi-evm-concurrency.spec.ts` NOT modified (confirmed via `git diff --stat`).
- Zero regression: full settler 108/108 (incl. gate 4/4), full shared 40/40.
- `shared` build clean.
- pnpm only; no emojis.
- Manual impact analysis: blast radius of optional `SettleBatchInput.events[]`
  field = the 2 adapter implementors + `submitViaAdapter` (the 3 edited sites);
  optional field → no other caller breaks. GitNexus analyze skipped per the
  CLAUDE.md worktree gotcha (would corrupt CLAUDE.md/AGENTS.md from a worktree).

## Files changed (6)

```
packages/shared/src/chain-adapter.ts                 | 10 +++
packages/shared/src/adapters/evm/index.ts            |  7 +-
packages/shared/src/adapters/solana/index.ts         |  6 +-
packages/settler/src/submitter/submitter.service.ts  |  5 ++
packages/settler/test/arc-testnet-settle-e2e.spec.ts | 32 ++++-
packages/shared/test/solana-adapter-parity.test.ts   | 90 ++++++++++++-
```
