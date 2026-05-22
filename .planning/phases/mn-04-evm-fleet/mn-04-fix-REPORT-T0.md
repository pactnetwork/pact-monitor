# MN-04 EVM settle-path fix-WP — Task 0 REPORT

**Crew:** crew-1
**Branch:** `fix/mn-04-evm-settle-path`
**Commit:** `e50f371` — `test(settler): add failing Arc Testnet settle e2e acceptance gate (mn-04 fix-WP T0)`
**Date:** 2026-05-22
**Status:** DONE — RED acceptance gate committed. No production code changed. Tasks 1-3 NOT started.

---

## 1. File created

`packages/settler/test/arc-testnet-settle-e2e.spec.ts` (new, 612 insertions in the commit incl. devDep wiring).

Commit also includes the harness wiring the test needs (no seam changes):
- `packages/settler/package.json` — added `hono` as a **devDependency** (the auth test mounts the REAL proxy middleware on a real Hono app).
- `pnpm-lock.yaml` — lockfile for the above.

`CLAUDE.md` / `AGENTS.md` were NOT touched (worktree gitnexus gotcha respected; `gitnexus analyze` deliberately NOT run from this worktree).

---

## 2. What the test wires REAL vs. substitutes

Crosses the real `settler -> adapter -> encode -> indexer` seam plus the proxy auth seam:

| Component | Real? | How |
|---|---|---|
| `SubmitterService` (settler) | REAL | constructed + `submit()` driven |
| `AdaptersService` (settler) | REAL | `onModuleInit()` builds the real `EvmAdapter` from `getChain("arc-testnet")` + `resolveDeployment(5042002)` |
| `EvmAdapter` (`@pact-network/shared`) | REAL | real `submitSettleBatch` / `checkAgentEligibility` |
| `encodeSettleBatch` (`@pact-network/protocol-evm-v1-client`) | REAL | reached through the real adapter call |
| `IndexerPusherService` (settler) | REAL | `push()` builds + POSTs the real body |
| `EventsService` (`@pact-network/indexer`, relative import) | REAL | `ingest()` run against an in-memory fake Postgres client |
| `verifyPactSignature` (`@pact-network/market-proxy`, relative import) | REAL | mounted on a real Hono app, driven with a real EIP-191 sig |
| viem `http` transport | SUBSTITUTED | only at the network boundary — `fetch` is stubbed to answer JSON-RPC. viem itself (clients, `http`, encoders) is 100% real. (Mocking the `viem` module does NOT work: `@pact-network/shared` resolves its own viem copy, so a module mock would not intercept the adapter — the fetch boundary does.) |
| Postgres client | SUBSTITUTED | in-memory fake recording every row's `network` (NEVER a real/prod DB) |
| Solana `Connection` + Solana decoders + `axios` | SUBSTITUTED | egress only (Solana RPC, indexer HTTP capture) — NOT the EVM seam |

The seam itself (`submitSettleBatch`, `encodeSettleBatch`, adapter dispatch) is never mocked.

---

## 3. Exact failure output (RED for the right reasons)

`pnpm --filter @pact-network/settler exec vitest run arc-testnet-settle-e2e`

```
 ❯ test/arc-testnet-settle-e2e.spec.ts (7 tests | 6 failed)
   × submit() reaches the real encoder with a 0x bytes16 call id ...
     → expected a 16-byte 0x hex value, got: 11111111222233334444555555555555
   × encodes the exact refundLamports on a breach, not the premium
     → expected a 16-byte 0x hex value, got: aaaaaaaabbbbccccddddeeeeeeeeeeee
   × indexer ingest writes Settlement / endpoint / PoolState / recipient-share rows ALL under arc-testnet
     → expected undefined to be 'arc-testnet'
   × authenticates a 0x / secp256k1 (EIP-191) agent through the real proxy auth middleware
     → expected 401 not to be 401
   × partitions a mixed-network pending set into single-network batches
     → expected 2 to be 1
   × partitions a mixed-slug pending set into single-slug batches
     → expected 2 to be 1

 Test Files  1 failed (1)
      Tests  6 failed | 1 passed (7)
```

Mapping to Rick's findings:

| Test | Asserts | Finding | RED reason |
|---|---|---|---|
| #3 submit→encode | encoder reached with 0x bytes16 callId from real UUID; calldata decodes to settleBatch | **2** | EVM callId built without `0x` (`submitter.service.ts:234` `.reduce(...,"")`) → `asBytes16` throws |
| #4 refund | breach encodes exact `refundLamports`, not premium | **2**+**6** | encode throws first (2); after a 0x fix it would still be RED on 6 (`refund = premium`, no `refundBaseUnits`) |
| #5 indexer | Settlement/endpoint/PoolState/share rows ALL under `arc-testnet` | **5** | pusher omits batch-level `network` (5a) → indexer defaults to `solana-devnet` (5b, verified — see §5) |
| #1 auth | 0x / secp256k1 EIP-191 agent accepted | **3** | middleware is Ed25519/bs58-only → returns 401 for the 0x agent |
| #6a partition (network) | mixed-network flush yields single-network batches | **4** | batcher splices ALL pending into one batch |
| #6b partition (slug) | mixed-slug flush yields single-slug batches | **4** | same |

The 1 passing test (#2, ERC-20 balance/allowance via the EVM adapter `eth_call`, never Solana) is an intentional GREEN guard: the EVM read path already works and must stay working. The acceptance gate is RED overall; the WP turns all 7 green.

---

## 4. The failure trace passes THROUGH `encodeSettleBatch` (captain gate)

Headline test #3 stack trace:

```
Error: expected a 16-byte 0x hex value, got: 11111111222233334444555555555555
 ❯ asBytes16 ../protocol-evm-v1-client/src/encode.ts:55:11
 ❯ ../protocol-evm-v1-client/src/encode.ts:225:17
 ❯ encodeSettleBatch ../protocol-evm-v1-client/src/encode.ts:224:14
 ❯ EvmAdapter.submitSettleBatch ../shared/src/adapters/evm/index.ts:334:39
 ❯ SubmitterService.submitViaAdapter src/submitter/submitter.service.ts:229:34
 ❯ test/arc-testnet-settle-e2e.spec.ts:388:5
```

`SubmitterService.submitViaAdapter` → real `EvmAdapter.submitSettleBatch` → real `encodeSettleBatch` → `asBytes16`. The real encoder is in the trace; nothing short-circuits it.

---

## 5. GREP proof — nothing mocks the seam

Run against the committed file (`git show HEAD:...`):

```
$ grep -nE "(mock|stub|spyOn)[^\n]*(submitSettleBatch|encodeSettleBatch)"
NONE — seam is never mocked

$ grep -nE "vi\.mock\(|vi\.stubGlobal\("
203: vi.mock("@solana/web3.js", ...)            # Solana RPC egress (not the EVM seam)
213: vi.mock("@pact-network/protocol-v1-client") # Solana account decoders (not the EVM seam)
226: vi.mock("axios")                            # capture indexer push body (pusher logic stays real)
364: vi.stubGlobal("fetch", vi.fn(fakeFetch))    # viem network boundary only
```

`submitSettleBatch` and `encodeSettleBatch` appear nowhere in the test as mock targets — they are only exercised through the real call path.

Finding 5b confirmation: with the 5a assertion temporarily bypassed, the real `EventsService.ingest()` ran against the fake Postgres and the aggregate rows came back `network: 'solana-devnet'` (`expected 'solana-devnet' to be 'arc-testnet'`), proving the indexer-write half of finding 5 is genuinely reached. The 5a assertion was then restored so the test gates 5a first, then 5b.

---

## 6. Regression check

`pnpm --filter @pact-network/settler exec vitest run` (full settler suite):

```
 Test Files  1 failed | 12 passed (13)
      Tests  6 failed | 76 passed (82)
```

Only the new acceptance file is RED (its 6 intended failures). All 12 other settler test files (76 tests) still pass — no regression from the test addition or the `hono` devDep.

---

## 7. Notes / decisions for the captain

- **devDep added:** `hono` (settler devDependency) so the auth test can mount the REAL `verifyPactSignature` on a real Hono app via `app.request(...)`. The indexer `EventsService` and the proxy middleware are imported by **relative path** (`../../indexer/src/...`, `../../market-proxy/src/...`); their own transitive deps (`@pact-network/db`, `tweetnacl`, `@nestjs/common`) resolve from each package's `node_modules`, so no extra settler deps were needed for those.
- **Transport substitution method:** stubbing `fetch` (viem's real `http` transport calls it) instead of mocking the `viem` module. This was required because `@pact-network/shared` resolves a separate viem copy that a module mock cannot reach; the fetch boundary is also the more honest "network egress only" substitution.
- **No production code touched.** Tasks 1-3 (the fixes) are not started, per scope.

## 8. Self-check vs. Task 0 acceptance bar

- [x] Real `SubmitterService` + real `EvmAdapter` + real `encodeSettleBatch` wired
- [x] Only the viem transport (fetch) + Postgres client substituted
- [x] (1) EVM auth path for 0x/secp256k1 — RED (finding 3)
- [x] (2) ERC-20 balance/allowance via EVM adapter, not Solana PDAs — GREEN guard
- [x] (3) submit reaches `encodeSettleBatch` with 0x bytes16 callId from real UUID — RED (finding 2), trace through encoder
- [x] (4) breach encodes exact refund, not premium — RED (findings 2 then 6)
- [x] (5) indexer rows ALL under `arc-testnet`, zero defaulted to `solana-devnet` — RED (finding 5a/5b)
- [x] (6) mixed-network / mixed-slug partitions correctly — RED (finding 4)
- [x] Committed with the exact required message
- [x] Nothing mocks `submitSettleBatch` / `encodeSettleBatch`
