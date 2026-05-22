# MN-04 EVM settle-path fix-WP — Task 1 REPORT

**Crew:** crew-1
**Branch:** `fix/mn-04-evm-settle-path`
**Date:** 2026-05-22
**Scope:** Task 1 — VM-aware settler submit path. Findings 1, 2, 4, 6.
**Status:** DONE. e2e is 6-of-8 green; the only RED tests are #5 (indexer / finding 5 → Task 2) and #1 (auth / finding 3 → Task 3), both out of Task 1 scope. Zero Solana regression.

---

## 1. Per-finding commits (in the captain's order)

| Order | Finding | Commit | What changed |
|---|---|---|---|
| 1 | **2** — 0x callId | `69bf45a` | `submitter.service.ts`: VM-aware `formatAdapterCallId` — EVM gets `0x`+32hex (encoder accepts), Solana keeps raw hex unchanged. (+ harness: finality-loop `eth_blockNumber`) |
| 2 | **1** — VM-aware load | `a67f55d` | `chain-adapter.ts`: optional `getEndpoint?`. `shared/adapters/evm`: `getEndpoint(slug)` single view call. `submitter.service.ts`: `loadFeeConfig` branches Solana=`loadEndpoint` / EVM=`adapter.getEndpoint`+`computeEvmFeeShares`. (+ harness: `getEndpoint` eth_call, finding-1 assertion, routing-stub `getEndpoint`) |
| 3 | **4** — partition | `cb286fd` | `batcher.service.ts`: `flush` partitions pending by `(network, slug)`, emits one single-network/single-slug batch per group. |
| 4 | **6** — refund | `d24a04b` | `chain-adapter.ts`: add `refundBaseUnits` to `SettleBatchInput.events[]`. `submitter`: pass `BigInt(refundLamports ?? '0')`. EVM + Solana adapters encode that exact value (was `breach ? premium : 0`). |

Production files touched: `packages/settler/src/submitter/submitter.service.ts`, `packages/settler/src/batcher/batcher.service.ts`, `packages/shared/src/chain-adapter.ts`, `packages/shared/src/adapters/evm/index.ts`, `packages/shared/src/adapters/solana/index.ts`.

Test/harness files touched (authorized): `packages/settler/test/arc-testnet-settle-e2e.spec.ts` (fake-transport extension + one new finding-1 assertion), `packages/settler/test/arc-testnet-routing.spec.ts` (EVM stub gains `getEndpoint`).

`packages/shared/dist/**` is gitignored (not committed); rebuilt locally — see §6.

---

## 2. e2e RED→GREEN progression (honest per-finding)

Acceptance test `arc-testnet-settle-e2e.spec.ts`. It gained one test in this task (the finding-1 assertion), so it has 8 tests.

| After | passed/total | Newly GREEN | Still RED |
|---|---|---|---|
| Task 0 (start) | 1/7 | #2 eligibility (guard) | #3, #4, #5, #1, #6a, #6b |
| Finding 2 (`69bf45a`) | 2/7 | #3 submit→encode | #4, #5, #1, #6a, #6b |
| Finding 1 (`a67f55d`) | 3/8 | finding-1 assertion (EVM submit, no Solana PDA reads) | #4, #5, #1, #6a, #6b |
| Finding 4 (`cb286fd`) | 5/8 | #6a, #6b partition | #4, #5, #1 |
| Finding 6 (`d24a04b`) | 6/8 | #4 refund | #5, #1 |

Final RED (both out of Task 1 scope):
- `indexer ingest ... ALL under arc-testnet` → `expected undefined to be 'arc-testnet'` — finding 5 (Task 2).
- `authenticates a 0x / secp256k1 (EIP-191) agent` → `expected 401 not to be 401` — finding 3 (Task 3).

Note on the green count: the captain anticipated "6-of-7 green". I added an 8th test (the authorized finding-1 assertion), and #5 (indexer/finding 5) is Task 2's scope per the plan, so the honest result is **6-of-8 green** with #5 and #1 remaining. Per "do what is best" I kept the Task 1/2 boundary clean and did not reach into the indexer package.

---

## 3. Full suite results — zero Solana regression

```
@pact-network/shared:  Test Files 7 passed (7)   |  Tests 36 passed (36)
@pact-network/settler: Test Files 1 failed | 12 passed (13)
                       Tests 2 failed | 81 passed (83)
```

The only settler failures are the 2 out-of-scope e2e reds above. Every other settler file is green, including the Solana parity guards:
- `adapter-swap-e2e.spec.ts` (byte-identical legacy vs adapter perEventShares) — green.
- `pipeline.e2e.spec.ts` (legacy-direct Solana path) — green.
- `submitter.service.spec.ts`, `batcher.service.spec.ts` — green.
- `arc-testnet-routing.spec.ts` — green (EVM stub updated to the new `getEndpoint` contract).

PR #224 hotfix regression test (`evm-adapter-unit.test.ts` getLogs chunking) — green (in the shared 36).

---

## 4. Parity verification against the on-chain Rust (finding 6)

`settle_batch.rs` is the source of truth and was read before editing:
- Wire layout (lines 34-47): `premium_lamports` at 64-71 and `refund_lamports` at 72-79 are **separate** fields.
- `let mut intended_refund_after_cap = refund_lamports;` (line 380) — the refund paid is the **supplied wire value**, clamped only by the hourly exposure cap and pool balance.
- It is **not** derived from premium and **not** gated by `breach` (breach only bumps `total_breaches`, line 390).

Therefore the old adapter behavior (`refund = breach ? premium : 0`) was wrong on both counts. Finding 6 encodes `refundBaseUnits` (= wire `refundLamports`) verbatim in both adapters, matching the Rust and the existing legacy-direct Solana path (`submitter.service.ts:334`). No contradiction with my design call — confirmed against Rust, so no STOP-AND-ASK needed.

---

## 5. Seam integrity (the rule that mattered last time)

```
$ grep -nE "(mock|stub|spyOn).*(submitSettleBatch|encodeSettleBatch)" arc-testnet-settle-e2e.spec.ts
NONE — seam never mocked
```

Acceptance-test assertion diff vs Task 0 (`e50f371 → HEAD`): the only `expect()` change is the **single added** finding-1 assertion `expect(getAccountInfoMock).not.toHaveBeenCalled();`. No existing assertion was removed or modified. The harness changes are transport responses only (`getEndpoint` eth_call, finality `eth_blockNumber`) and a `getEndpoint` result fixture — exactly the "extend harness only" scope authorized for finding 1, and nothing relaxes the no-seam-mock rule.

---

## 6. How to reproduce (build-before-test)

Settler tests resolve `@pact-network/shared` via its **built dist** (turbo `test` `dependsOn: ["^build"]`). After pulling these commits, build shared before running the settler suite:

```
pnpm --filter @pact-network/shared build      # or: pnpm -r build
pnpm --filter @pact-network/shared test        # 36 passed
pnpm --filter @pact-network/settler test       # 81 passed; 2 e2e reds (Task 2/3)
```

`pnpm -r test` / `pnpm turbo run test` does the `^build` automatically.

---

## 7. Notes / decisions for the captain

- **STOP-AND-ASK resolved up front:** finding 1's faithful fix needs an EVM endpoint read the frozen harness couldn't answer. Per your "Extend test harness only" decision I added a single-slug `EvmAdapter.getEndpoint()` (one `eth_call`, no `eth_getLogs`/`authority`), taught the fake transport to answer it, and added the finding-1 assertion. Existing assertions untouched.
- **Design call confirmations:** finding 4 partitions in the batcher (your call); finding 6 uses `refundBaseUnits` on `SettleBatchInput.events[]` (your call) and is Rust-parity-verified (§4).
- **`arc-testnet-routing.spec.ts`** (the old stub-the-adapter routing unit test, not the acceptance test) needed its EVM stub to implement `getEndpoint` to match the new adapter contract — updated; this is mock maintenance, not a Solana regression.
- **Pre-existing (not mine):** `pnpm --filter @pact-network/settler typecheck` reports 2 errors in `indexer-pusher.service.spec.ts` and `submitter.service.spec.ts` (SettleMessage `ack`/`nack`/`raw` fixture shape). Verified present before my changes; the settler test gate is vitest, not tsc. Left untouched (out of scope).
- **gitnexus** not run (worktree corrupts CLAUDE.md/AGENTS.md per repo rule; also pact-network isn't in the local gitnexus index). Impact analysis was manual.

## 8. Self-check vs. Task 1

- [x] Finding 2 GREEN (commit, e2e re-run) — #3 green
- [x] Finding 1 GREEN (commit, e2e re-run) — EVM reads via adapter, never Solana PDAs (asserted)
- [x] Finding 4 GREEN (commit, e2e re-run) — #6a/#6b green
- [x] Finding 6 GREEN (commit, e2e re-run) — #4 green; Rust-parity verified
- [x] Solana path byte-identical/green — shared 36, settler 81, all Solana guards green
- [x] Did not modify acceptance-test assertions; seam never mocked
- [x] #1 (auth) left RED for Task 3; #5 (indexer) left RED for Task 2
