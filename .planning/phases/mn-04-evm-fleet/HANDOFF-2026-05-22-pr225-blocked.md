# Handoff — WP-MN-04 / PR #225 BLOCKED by Rick review

- **Written:** 2026-05-22, end of session, for a fresh next-session start.
- **One-line state:** The "multi-network" rollup PR #225 (feat/multi-network -> develop) is **CHANGES_REQUESTED by Rick (metalboyrick)** with 6 verified blocking findings. The EVM read path + abstraction are real; the EVM **write/settle/auth/accounting path does not work**. T6 Cloud Run deploy is **PAUSED**.

## Do not do these (hard constraints)

- **Do NOT flip Cloud Run / enable arc-testnet.** Flipping `PACT_ENABLED_NETWORKS=...,arc-testnet` today hits findings 1/2/3 on the first real Arc call. T6 is paused until the fix-WP lands.
- **Tu has NO GCP perms** — Rick owns all gcloud (Secret Manager, Cloud Run, IAM). See memory `project-gcp-ownership`.
- **Anchor crate is FROZEN** — do not touch. **pnpm not npm. No emojis. No blockquotes in copy-paste content. No production-DB writes** (local docker postgres only).
- **No remote pushes / no merges without Tu's explicit go.**

## What is TRUE / works (verified this session)

- T1 `chains.json` + `ChainDescriptor` — real.
- EVM contracts deployed on Arc Testnet (registry `0x056BAC33546b5b51B8CF6f332379651f715B889C`, pool `0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE`, settler `0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f`, USDC `0x3600...0000`, chain 5042002). Tu's `grantRole(SETTLER_ROLE, 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859)` landed: tx `0x383ba632ff34366b4a98461bf0301574f70e4ce8ae014a27f77ef425d74d9f65`, block 43317982, hasRole=true.
- `EvmAdapter` **read-only** methods work, smoke-tested live: `readEndpointConfigs` + `checkAgentEligibility` (after the two hotfixes below).
- **Two real hotfixes merged (PR #224, commit on feat/multi-network `c2863ae`)** — KEEP THESE: (a) `readEndpointConfigs`/`tailSettlementEvents` paginate `eth_getLogs` into 9.5k-block windows (Arc caps at 10k); (b) viem chain object now carries canonical Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`. +1 regression test in `evm-adapter-unit.test.ts`.
- Solana path unchanged / still byte-identical / works.
- Smoke scripts (read-only, safe to re-run): `/tmp/arc-testnet-readonly-smoke.mjs`, `/tmp/solana-devnet-readonly-smoke.mjs`.

## What is BROKEN — Rick's 6 findings (ALL verified true in code this session)

| # | File:line | Bug | Fix direction |
|---|---|---|---|
| 1 | `settler/src/submitter/submitter.service.ts:227` | `submitViaAdapter` calls `loadEndpoint(slug)` unconditionally -> Solana PDAs/RPC even for arc-testnet. Arc-only endpoint fails before `EvmAdapter.submitSettleBatch`; same-slug Solana endpoint leaks Solana fee metadata into EVM tx | Make VM-aware: for EVM derive fee fan-out from `EvmAdapter.readEndpointConfigs`/`getEndpoint`, not Solana PDAs |
| 2 | `submitter.service.ts:234-238` vs `protocol-evm-v1-client/src/encode.ts:52-56` | EVM call IDs emitted **without `0x`** (`parseCallId().reduce(...,"")`); `encodeSettleBatch`->`asBytes16` requires `0x`+32hex. Every adapter-path EVM settle throws before gas est | `0x`-prefix EVM call IDs; add settler test reaching `encodeSettleBatch` with a real UUID |
| 3 | `market-proxy/src/middleware/verify-signature.ts:133-145` | Auth is Ed25519/bs58-only (`bs58.decode`, len 32/64, `nacl.verify`). EVM agent (0x addr, secp256k1) cannot authenticate | Add EVM auth mode selected by endpoint.network: `x-pact-agent: 0x...` + EIP-191/712 recover; keep Ed25519 for Solana |
| 4 | `batcher.service.ts:67` + `submitter.service.ts:175-184,217-220` | Batcher splices ALL pending into one batch (does NOT group by slug despite comment); submitter routes whole batch by message[0] network/slug | Partition pending by `(network, endpointSlug)` before flush; or per-event network/slug in `SettleBatchInput.events[]`. Mixed-network/slug regression tests |
| 5 | `settler/src/indexer/indexer-pusher.service.ts:93-104` + `indexer/src/events/events.service.ts:130-139,180,313-317` | Pusher sends no batch-level network; indexer defaults Settlement/endpoint-FK/PoolState/shares to `solana-devnet`. Arc aggregates land under Solana or FK-fail | Pusher includes batch network + single-network-per-batch; indexer stops defaulting to solana-devnet |
| 6 | `submitter.service.ts:232-245` + `shared/src/adapters/evm/index.ts:322-328` + `adapters/solana/index.ts:234-235` | `refundLamports` dropped; both adapters encode `refund = premium` on breach (input only carries `outcome`) | Add `refundBaseUnits` to `SettleBatchInput.events[]`; pass `BigInt(d['refundLamports'] ?? '0')`; adapters encode that exact value |

Plus (from earlier investigation, not in Rick's list but real): **no EVM endpoint-registration tooling** — Pact CLI is 100% Solana (no `endpoint register` command, no viem imports), dashboard is Solana-only, curated providers default to `network="solana-devnet"`. EVM endpoints must be registered via direct `cast send PactRegistry.registerEndpoint(...)`.

Rick's merge bar (the acceptance test): authenticated Ethereum address -> ERC-20 balance/allowance -> EVM `settleBatch` calldata encode -> indexer ingest with **all rows under arc-testnet**.

## Root cause (so we don't repeat it)

- **Gates verified task completion, not goal achievement.** When T5 was cut to "routing-dispatch only" after the Mac restart (Option C), the only test that would reach `encodeSettleBatch` was removed. No gate re-asked "is the goal still reachable with this cut?"
- **Mocks disagreed with reality at the seams.** `evm-adapter-unit.test.ts:89` hand-feeds a valid `0x` callId so encode passes; `arc-testnet-routing.spec.ts:196` stubs `submitSettleBatch` entirely so encode is never reached. No test crosses settler->adapter->encode->indexer with real data. `grep` confirms nothing reaches `encodeSettleBatch` through the real path.
- **Gate B report leaned on a false analogy** (`mn-04-REPORT-gateB.md:101`): "rely on WP-MN-03b byte-identical adapter-swap e2e ... (Solana side; the topology is identical for EVM)". The topology is NOT identical (0x callIds, secp256k1 auth, EVM endpoint state, refund != premium).
- **My live smoke created false confidence** — it exercised only the read half, but was reported as whole-path validation.

**Process fix:** any mid-flight scope cut triggers a goal-backward reachability re-check, not just a task re-plan. Integration test must cross the real seam with real data before a phase is called done.

## The fix-WP plan (tasks already created)

- **#55 fix-WP T0** — write the FAILING Arc e2e acceptance test FIRST (goal-backward). This is the gate for the whole WP.
- **#56 fix-WP T1** — settler submit path VM-aware (findings 1,2,4,6). Blocked by #55.
- **#57 fix-WP T2** — indexer EVM accounting (finding 5). Blocked by #56.
- **#58 fix-WP T3** — proxy EVM identity/auth mode (finding 3).
- **#53** — T6 deploy PAUSED until the above land + e2e passes.

Suggested execution: subagent-driven-development, but with the e2e written and RED before any fix subagent runs. Consider a proper `superpowers:writing-plans` plan doc first given the scope and the prior failure.

## Still owed

- **Reply to Rick on PR #225** acknowledging all 6 findings + the fix grouping (drafted in conversation, not yet posted).
- The Slack reply to Rick's "is it just multi-chain base?" question (drafted, not sent).

## Branch / PR state

- `feat/multi-network` @ `c2863ae` (includes PR #222 main work + PR #224 hotfix).
- PR #225 (feat/multi-network -> develop) OPEN, CHANGES_REQUESTED.
- Rollback tag `pre-mn-05-rollback` on feat/multi-network.
- Memory: `project-solana-program-id-drift` (separate pre-existing issue: SolanaAdapter defaults to mainnet PROGRAM_ID; live devnet is the one labeled ORPHAN; masked by PACT_LEGACY_DIRECT_SOLANA=true; must be fixed before the cleanup WP flips that flag).
