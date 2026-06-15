# MN-04 EVM Settle-Path Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every task and superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Hard gate (read before touching code):** Task 0 writes a FAILING Arc Testnet end-to-end acceptance test that crosses the REAL settler -> adapter -> encode -> indexer seam with REAL data. It MUST be RED for the right reason before any fix task runs, and GREEN before the WP is called done. Do NOT mock `submitSettleBatch`, `encodeSettleBatch`, or the adapter dispatch in this test — mocking those seams is exactly the bug that let 6 findings ship. Only the network egress (RPC `sendTransaction` / `eth_call`) and the Postgres client may be substituted, and only with fakes that preserve real input/output shapes.

**Goal:** Make the EVM (Arc Testnet) write/settle/auth/accounting path actually function end-to-end, so an authenticated Ethereum agent's settled call flows through the settler, encodes a real `settleBatch` calldata, and lands in the indexer entirely under `arc-testnet` — clearing all 6 of Rick's blocking findings on PR #225.

**Architecture:** The read path (`readEndpointConfigs`, `checkAgentEligibility`) and the `ChainDescriptor`/adapter abstraction already work and are NOT touched. This WP fixes the write half along four seams: (1) the settler submit path becomes VM-aware instead of unconditionally Solana, (2) the indexer stops defaulting aggregates to `solana-devnet`, (3) the proxy gains an EVM auth mode, and (4) refund amounts are threaded through instead of being faked as `refund = premium`. A single real-seam e2e test is the acceptance gate and is written first.

**Tech Stack:** TypeScript, NestJS (settler + indexer), Hono (market-proxy), viem (`@pact-network/protocol-evm-v1-client`), `@solana/web3.js` (Solana adapter), Vitest, local docker Postgres (NEVER production DB), pnpm + turbo.

---

## Constraints (carry into every task)

- **pnpm, not npm. No emojis. No blockquotes in copy-paste content. No production-DB writes** (local docker Postgres only).
- **No remote pushes / no merges without Tu's explicit go.** Local commits per task are fine and expected.
- **Anchor crate is FROZEN** — do not touch.
- **Solana source is the source of truth** for fee/error/accounting parity. Where any plan/spec sketch conflicts with the on-chain Rust (`fee.rs`, `error.rs`, `settle_batch.rs`), the Rust wins. Re-derive from it; do not trust prose.
- **PR #224 hotfixes are correct and must stay** (eth_getLogs 9.5k-block pagination + Multicall3 wiring). Do not regress them.
- **Goal-backward rule:** any mid-task scope cut triggers a reachability re-check against the Task 0 e2e — "does the acceptance test still pass with this cut?" — NOT just a task re-plan. If the answer is no or unknown, STOP-AND-ASK the captain.

## The acceptance bar (Rick's merge gate)

Authenticated Ethereum address -> ERC-20 balance/allowance check -> EVM `settleBatch` calldata encode (must reach `encodeSettleBatch` with a real UUID-derived call ID) -> indexer ingest with **all rows under `arc-testnet`** (Settlement, endpoint FK, PoolState, recipient shares). Refund value on a breach must equal the real refund amount, not the premium.

## File Structure (what each task touches)

| Area | Files | Responsibility |
|---|---|---|
| Acceptance test (Task 0) | NEW e2e spec under `packages/settler/test/` (mirror existing settler integration scaffolding) | Cross the real settler->adapter->encode->indexer seam for an Arc batch; RED first |
| Settler submit (Task 1) | `packages/settler/src/submitter/submitter.service.ts` (227, 234-238, 175-184, 217-220, 232-245), `packages/settler/src/batcher/batcher.service.ts:67`, `packages/shared/src/adapters/evm/index.ts:322-328`, `packages/shared/src/adapters/solana/index.ts:234-235`, `packages/protocol-evm-v1-client/src/encode.ts:52-56` | VM-aware submit; 0x call IDs; partition by (network,slug); thread refund |
| Indexer accounting (Task 2) | `packages/settler/src/indexer/indexer-pusher.service.ts:93-104`, `packages/indexer/src/events/events.service.ts:130-139,180,313-317` | Batch-level network; stop defaulting to solana-devnet |
| Proxy auth (Task 3) | `packages/market-proxy/src/middleware/verify-signature.ts:133-145` | EVM auth mode (secp256k1 / EIP-191) selected by endpoint.network |

---

## Task 0: Failing Arc e2e acceptance test (THE GATE)

**Files:**
- Create: e2e spec in `packages/settler/test/` (name it `arc-testnet-settle-e2e.spec.ts`; mirror the harness style of the existing settler integration tests, NOT the unit mocks in `arc-testnet-routing.spec.ts` / `evm-adapter-unit.test.ts`).

**This test is the whole WP's contract. It must exercise the REAL path:**

- [ ] **Step 1: Read the existing test scaffolding first.** Read `packages/settler/src/submitter/submitter.service.ts`, `batcher.service.ts`, `indexer-pusher.service.ts`, `packages/shared/src/adapters/evm/index.ts`, `packages/protocol-evm-v1-client/src/encode.ts`, and the indexer `events.service.ts`. Identify the exact seam objects so the test wires the real `SubmitterService` + real `EvmAdapter` + real `encodeSettleBatch`, substituting ONLY the viem transport (so `sendTransaction`/`eth_call` don't hit the live chain) and the Postgres client (local fake or docker test DB). Do NOT stub `submitSettleBatch` or `encodeSettleBatch`.

- [ ] **Step 2: Write the failing acceptance test.** It must assert, end-to-end for an `arc-testnet` batch built from a real UUID call ID and an Ethereum (`0x`) agent address:
  1. The agent authenticates through the EVM auth path (secp256k1/EIP-191) — not Ed25519.
  2. ERC-20 balance/allowance is read via the EVM adapter (not Solana PDAs).
  3. The submit path reaches `encodeSettleBatch` with a properly `0x`-prefixed `bytes16` call ID derived from the real UUID (assert no throw, assert calldata is produced and decodes to the expected `settleBatch` selector + args).
  4. On a breach event with `refundLamports` set, the encoded refund equals that exact value — NOT the premium.
  5. The indexer ingest writes Settlement, endpoint FK, PoolState, and recipient-share rows ALL with `network = 'arc-testnet'` (assert zero rows defaulted to `solana-devnet`).
  6. A mixed-network and/or mixed-slug pending set produces correctly partitioned batches (no Arc event routed by a Solana message[0]).

- [ ] **Step 3: Run it and confirm RED for the right reasons.** Run: `pnpm --filter @pact-network/settler test arc-testnet-settle-e2e` (adjust to the repo's actual test invocation). Expected: FAIL — specifically at the seams the 6 findings describe (Solana `loadEndpoint` on Arc path, missing `0x` prefix throw in `asBytes16`, Ed25519-only auth rejecting the 0x address, batch mis-partition, solana-devnet default rows, refund=premium). Capture the failure output. If it fails for an unrelated reason (e.g. test harness wiring), fix the harness — NOT by mocking the seam — until it fails for the finding reasons.

- [ ] **Step 4: Commit the RED test.**
```bash
git add packages/settler/test/arc-testnet-settle-e2e.spec.ts
git commit -m "test(settler): add failing Arc Testnet settle e2e acceptance gate (mn-04 fix-WP T0)"
```

**Captain review gate:** Do not start Task 1 until the captain confirms the RED test reaches the real seam (verify by `grep` that nothing in this test mocks `submitSettleBatch`/`encodeSettleBatch`, and that the failure trace passes through `encodeSettleBatch`).

---

## Task 1: VM-aware settler submit path (findings 1, 2, 4, 6)

Blocked by Task 0 (RED). Drive each sub-fix by turning the relevant slice of the Task 0 e2e (or a focused sibling test) GREEN, one finding at a time, committing per finding.

**Files:** `submitter.service.ts`, `batcher.service.ts`, `shared/src/adapters/evm/index.ts`, `shared/src/adapters/solana/index.ts`, `protocol-evm-v1-client/src/encode.ts`.

- [ ] **Finding 2 first (cheapest, unblocks encode): 0x-prefix EVM call IDs.** In `submitter.service.ts:234-238`, the EVM call-ID build (`parseCallId().reduce(...,"")`) must produce `0x`+32hex so `encodeSettleBatch`->`asBytes16` accepts it. Write/extend a test that feeds a real UUID through the real encode and asserts success. Fix. Run. Commit.

- [ ] **Finding 1: VM-aware endpoint load.** `submitter.service.ts:227` calls Solana `loadEndpoint(slug)` unconditionally. For `network === 'arc-testnet'` (EVM), derive fee fan-out from `EvmAdapter.readEndpointConfigs`/`getEndpoint`, never Solana PDAs. Guard so a same-slug Solana endpoint cannot leak fee metadata into an EVM tx. Test both: Arc-only slug succeeds; same-slug-on-both does not cross-contaminate. Fix. Run. Commit.

- [ ] **Finding 4: partition pending by (network, endpointSlug).** `batcher.service.ts:67` splices ALL pending into one batch despite the grouping comment; `submitter.service.ts:175-184,217-220` then routes the whole batch by `message[0]`. Partition before flush (or carry per-event network/slug in `SettleBatchInput.events[]`). Add mixed-network and mixed-slug regression tests. Fix. Run. Commit.

- [ ] **Finding 6: thread real refund.** `refundLamports` is dropped; both adapters encode `refund = premium` on breach (`evm/index.ts:322-328`, `solana/index.ts:234-235`). Add `refundBaseUnits` to `SettleBatchInput.events[]`; in the submitter pass `BigInt(d['refundLamports'] ?? '0')`; both adapters encode that exact value. Test: breach event with refund != premium encodes the refund value on BOTH adapters (parity). Fix. Run. Commit.

- [ ] **Re-run the full Task 0 e2e.** Steps 3+5 of the acceptance test should now pass; the auth step (finding 3) still RED until Task 3. Confirm the encode/partition/refund/accounting-input portions are GREEN.

**Captain review gate:** confirm Solana path tests still byte-identical/green (no regression), and the e2e reaches `encodeSettleBatch` via the real path.

---

## Task 2: Indexer EVM accounting (finding 5)

Blocked by Task 1.

**Files:** `settler/src/indexer/indexer-pusher.service.ts:93-104`, `indexer/src/events/events.service.ts:130-139,180,313-317`.

- [ ] **Step 1: Failing test.** Assert that an Arc batch ingested by the indexer writes Settlement, endpoint-FK, PoolState, and recipient-share rows all under `arc-testnet`, and that none default to `solana-devnet`. (This is the e2e's step 5 isolated against the indexer service.)
- [ ] **Step 2: Pusher includes batch network.** `indexer-pusher.service.ts:93-104` currently sends no batch-level network. Add it; enforce single-network-per-batch (consistent with Task 1 partitioning).
- [ ] **Step 3: Indexer stops defaulting to solana-devnet.** `events.service.ts:130-139,180,313-317` must use the batch network for Settlement/endpoint-FK/PoolState/shares instead of the `solana-devnet` default. Keep Solana batches landing under `solana-devnet` (regression test).
- [ ] **Step 4: Run + commit.** Run the indexer test + the Task 0 e2e step 5. Expected GREEN. Commit.

**Captain review gate:** confirm Solana ingest still lands under `solana-devnet` (no regression) and Arc rows are 100% `arc-testnet`.

---

## Task 3: Proxy EVM auth mode (finding 3)

Independent of Tasks 1-2 (can run in parallel by a separate crew once Task 0 is RED), but the Task 0 e2e's auth step depends on it.

**Files:** `market-proxy/src/middleware/verify-signature.ts:133-145`.

- [ ] **Step 1: Failing test.** An Ethereum agent (`x-pact-agent: 0x...`, secp256k1 signature) authenticates successfully against an `arc-testnet` endpoint; a Solana agent still authenticates via Ed25519/bs58 against a Solana endpoint; cross-mode mismatches are rejected.
- [ ] **Step 2: Add EVM auth mode.** Current code is Ed25519/bs58-only (`bs58.decode`, len 32/64, `nacl.verify`). Select auth mode by `endpoint.network`: for EVM, accept `0x` address + EIP-191 (personal_sign) signature and recover/verify the signer matches the claimed address; keep Ed25519 for Solana. Use viem's `recoverMessageAddress`/`verifyMessage` (already a workspace dep via the EVM client) rather than hand-rolling secp256k1.
- [ ] **Step 3: Run + commit.** Run proxy middleware tests + Task 0 e2e step 1. Expected GREEN. Commit.

**Captain review gate:** confirm Solana auth path unchanged (regression test green).

---

## Final gate: full e2e GREEN

- [ ] Run the Task 0 acceptance e2e in full. ALL steps (1-6) GREEN.
- [ ] Run `pnpm -r test` for settler, indexer, shared, market-proxy, protocol-evm-v1-client, protocol-v1-client (Solana). No regressions.
- [ ] Confirm PR #224 hotfix regression test (`evm-adapter-unit.test.ts` getLogs chunking) still green.
- [ ] Captain assembles the PR (separate from PR #225) and drafts the Rick reply mapping each of the 6 findings to its fix commit. **Do not push/open the PR without Tu's explicit go.**

---

## Out of scope (track separately, do NOT fold in)

- **EVM endpoint-registration tooling** (Pact CLI is Solana-only; no `endpoint register` cmd; dashboard Solana-only; curated providers default `solana-devnet`). EVM endpoints are registered via direct `cast send PactRegistry.registerEndpoint(...)`. Real gap, but not one of Rick's 6 findings — separate WP.
- **Solana program-id drift** (memory `project-solana-program-id-drift`): SolanaAdapter defaults to mainnet PROGRAM_ID; live devnet is the ORPHAN-labeled program; masked by `PACT_LEGACY_DIRECT_SOLANA=true`. Must be fixed before the cleanup WP flips that flag false — separate from this WP.
- **T6 Cloud Run deploy** (task #53): stays PAUSED until this WP's e2e is GREEN and the PR is approved. Rick owns gcloud.

## Self-review notes

- Spec coverage: all 6 findings map to a task (2,1,4,6 -> Task 1; 5 -> Task 2; 3 -> Task 3) and the acceptance e2e (Task 0) is Rick's exact merge bar. Covered.
- The plan deliberately does NOT pre-author full implementation code: the executor reads the cited files and writes real tests/code via TDD. The non-negotiables (real-seam test first, RED-before-fix, goal-backward gate, no mocking the settle seam) are pinned because those are exactly what failed last time.
- Type/name consistency: `refundBaseUnits` is the new field name used in both Task 1 (submitter + adapters) and the e2e; `SettleBatchInput.events[]` is the carrier in both.
