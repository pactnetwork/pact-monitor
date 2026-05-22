# Review #226 — FIX F4 + F5 + F6 (follow-ups) — REPORT

**Status:** DONE (all 3 follow-up findings resolved)
**Branch:** `feat/concurrent-multi-evm`
**Commits (one per finding, each test RED-first):**

| Finding | Commit | Subject |
|---|---|---|
| F4 | `5de3e66` | `fix(shared): slice feeRecipients to feeRecipientCount in readEndpointConfigsFrom (review #226 F4)` |
| F5 | `a6662cc` | `fix(settler): enforce single-slug invariant in indexer pusher (review #226 F5)` |
| F6 | `2db6b97` | `fix(settler): use JSON.stringify structured partition key in batcher (review #226 F6)` |

---

## F4 — readEndpointConfigsFrom projected the full padded FeeRecipient[8]

**File:** `packages/shared/src/adapters/evm/index.ts` (`readEndpointConfigsFrom`, ~297-313)

**Finding:** the cursor-able config sync projected the FULL fixed `FeeRecipient[8]`
array — `maxTotalFeeBps: c.feeRecipients.reduce(...)` and
`feeRecipients: c.feeRecipients.map(...)` over all 8 entries — while the
single-slug `getEndpoint()` (same file, ~343-350) already slices to
`feeRecipientCount` first. The zero-padded tail leaked into the snapshot and
`maxTotalFeeBps` was summed over entries the settler never pays.

**Fix:** mirror `getEndpoint` — `const count = Number(c.feeRecipientCount); const
recipients = c.feeRecipients.slice(0, count);` and compute `maxTotalFeeBps` /
`feeRecipients` from the sliced `recipients`. Both EVM read paths now drop the
padded tail identically.

**Test (RED first):** `evm-adapter-unit.test.ts`, in the
`readEndpointConfigsFrom` describe — `slices feeRecipients to feeRecipientCount,
dropping the padded [8] tail (F4)`. A config with `feeRecipientCount=2` and a
`FeeRecipient[8]` array whose 6 padded entries carry **non-zero** bps (100 each)
so a missing slice corrupts BOTH the recipient count AND the sum.
- **RED:** `expected [...8] to have a length of 2 but got 8` (full array leaked).
- **GREEN:** `feeRecipients.length === 2`, `maxTotalFeeBps === 500` (300+200, not
  300+200+600=1100).

## F5 — indexer pusher enforced single-network but not single-slug

**File:** `packages/settler/src/indexer/indexer-pusher.service.ts` (~push + new
private guard)

**Finding:** the batcher now partitions pending by `(network, endpointSlug)`, but
the submitter routes the whole adapter batch by the first message's slug. The
pusher enforced the single-NETWORK invariant (`resolveBatchNetwork` throws on a
mixed-network batch) but had no equivalent single-SLUG guard, so a future direct
caller or batcher regression would mis-index a mixed-slug batch under one
endpoint's config silently.

**Fix:** added `assertSingleSlug(batch)`, a direct mirror of
`resolveBatchNetwork`'s single-network enforcement — it reads each message's
`endpointSlug`, throws `indexer push received a mixed-slug batch (<a> vs <b>); the
batcher must partition by slug before flush` on divergence. Called in `push`
immediately after `resolveBatchNetwork`, before any wire payload is built (so a
mixed-slug batch fails loud, never posts).

**Test (RED first):** `indexer-pusher.service.spec.ts` — `throws on a mixed-slug
batch (single-slug invariant)`, mirroring the existing mixed-network test. Two
messages with `endpointSlug` `helius` vs `birdeye`.
- **RED:** `push` did not reject (no guard) — assertion `rejects.toThrow` failed.
- **GREEN:** throws `/mixed-slug batch/`.

## F6 — batcher partition key was a fragile single-byte-separated string

**File:** `packages/settler/src/batcher/batcher.service.ts:86`

**Finding (as stated):** the `(network, slug)` partition key uses a space
separator (the original literal NUL "was already removed"); Rick wants a robust
structured key, `const key = JSON.stringify([network, slug])`.

**Correction to the finding's premise (surfaced, not blocked):** the live
separator was NOT a space. `hexdump` of line 86 showed a **literal NUL byte
(0x00)** still embedded in the template — `` `${network}\u0000${slug}` `` (the
NUL renders as a blank in editors/`sed`, which is why it looked like a space, and
why `git` flagged the file as binary and plain-string edit tooling could not
match the line). The prescribed fix is correct and unchanged regardless — it
eliminates exactly this single-byte-separator fragility — so I applied it and
documented the discrepancy here rather than blocking on a non-decision.

**Fix:** `const key = JSON.stringify([network, slug]);`. As a side-benefit the
raw NUL byte is gone, so the source file is plain text again (git no longer
treats it as binary). The key is internal to `flush()` (Map grouping + the
isolation error log); no external caller depends on its format.

**Test (RED first):** `batcher.service.spec.ts` — new describe `structured
partition key (review #226 F6)`. The collision test uses the **actual** live
separator (`const SEP = "\u0000"`, the clean escape — no raw NUL introduced into
the test source) and the generic single-byte collision construction: distinct
pairs `(X, SEP+Y)` and `(X+SEP, Y)` both join to `X+SEP+SEP+Y`.
- `does not collide distinct (network,slug) pairs when a field contains the
  separator char` — **RED:** the two distinct pairs merged into 1 batch
  (`expected [Array(1)] to have a length of 2 but got 1`); **GREEN:** 2 batches.
- `still groups identical (network,slug) messages into one batch` — companion
  guard that partitioning still groups correctly (1 batch, 2 messages). Green
  before and after.

JSON.stringify quotes/escapes each field, so distinct pairs always produce
distinct keys regardless of field content.

## Before / after suites

| Suite | Before | After |
|---|---|---|
| Full shared suite | 40 passed | **41 passed** (+1 F4) |
| Full settler suite | 108 passed | **111 passed** (+1 F5, +2 F6) |
| — multi-evm-concurrency gate | 4/4 green | 4/4 green (file untouched) |
| `shared` build (`tsc`) | clean | clean |
| `settler` build (`nest build`) | clean | clean |

`shared` was rebuilt (`pnpm --filter @pact-network/shared build`) before running
the settler suites.

## Compliance with hard rules

- **TDD RED-first each:** all 3 tests watched fail for the correct reason before
  any production edit (F4 length 8≠2; F5 push did not throw; F6 distinct pairs
  merged to 1 batch). F6 in particular: the first-cut test passed pre-fix because
  it assumed a space separator — re-derived against the real NUL separator until
  it went genuinely RED.
- **Gate untouched:** `multi-evm-concurrency.spec.ts` not modified
  (`git status --short` clean); gate 4/4 after all fixes.
- **Zero regression:** full settler 111/111 (incl. gate 4/4), full shared 41/41;
  both builds clean.
- **Surgical:** 6 files, every changed line traces to F4/F5/F6; no drive-by
  refactors. F4 mirrors the existing `getEndpoint` slice; F5 mirrors the existing
  `resolveBatchNetwork` guard.
- **pnpm only; no emojis.**
- **Manual impact analysis** (gitnexus `analyze` skipped per the CLAUDE.md
  worktree gotcha — it would rewrite CLAUDE.md/AGENTS.md to the worktree dir
  name; verified no CLAUDE.md/AGENTS.md changes in the commits):
  - F4: `readEndpointConfigsFrom` callers = `readEndpointConfigs` (same file) +
    the indexer config-sync; output shape unchanged (just drops padding) — same
    projection `getEndpoint` already produces. Low risk.
  - F5: `assertSingleSlug` is a new private method, one call site in `push`; only
    adds a throw path the pipeline already handles like the existing
    mixed-network throw. Low risk.
  - F6: `key` is local to `flush()` (Map grouping + log line); no external
    consumer of the key format. Low risk.

## Files changed (6)

```
packages/shared/src/adapters/evm/index.ts                  | 41 +++++++------
packages/shared/test/evm-adapter-unit.test.ts              | 46 ++++++++++++
packages/settler/src/indexer/indexer-pusher.service.ts     | 28 ++++++++
packages/settler/src/indexer/indexer-pusher.service.spec.ts| 14 ++++
packages/settler/src/batcher/batcher.service.ts            | (NUL removed; key -> JSON.stringify)
packages/settler/src/batcher/batcher.service.spec.ts       | 62 ++++++++++++++++
```
