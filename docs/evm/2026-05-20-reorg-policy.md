# Pact Multi-Network — Per-VM Reorg & Finality Policy (D6)

- **Date:** 2026-05-20
- **Status:** DRAFT — hard Gate A entry artifact for WP-MN-04. Off-chain spec §2.6 ("greenfield, unspecified today") is closed here.
- **Owner:** captain-proxy on behalf of Tu (out-of-office). Tu signs off before any EVM fleet boots.
- **Referenced by:** `docs/evm/2026-05-19-multi-network-offchain-services-spec.md` §2.6; `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §7 (WP-MN-04 Gate A entry, plan-level risk PR-R3).
- **Applies to:** settler.submitter, indexer.events ingest, indexer reorg-rollback. Does NOT touch on-chain code.

## 0 · Why this doc exists before any code

Solana settlement is on-chain-idempotent via the `CallRecord` PDA: the program rejects a duplicate `callId` whether you replay the same tx or a different one. EVM has no PDA analogue. The on-chain `DuplicateCallId` guard in `PactSettler.sol` is the backstop, but the wire-level idempotency keys and the database state both need to survive an EVM reorg, where the same logical settlement can resurface under a different `txHash`. We pick the policy now so the indexer never gets into a corrupt state, then build the fleet against the policy.

## 1 · Two concrete per-VM finality semantics

| VM | Commitment for **submit** | Commitment for **ingest** | Notion of "this is irreversible" |
|---|---|---|---|
| Solana | `confirmed` for first response (fast UX); `finalized` for idempotency-critical decisions (none on the submit path — the program itself enforces uniqueness) | `finalized` (the indexer push from settler waits for `finalized` before publishing) | Slot reaches `finalized` super-majority (rooted). Reorgs above finalized are network-halting events, not normal. |
| EVM (Arc) | broadcast → wait `finalityBlocks` confirmations on receipt before HTTP-pushing to indexer | indexer receives only post-finality events from settler; reconciliation tail-events use `getLogs({finalized:true})` only | Block at depth `>= finalityBlocks` deep on the canonical chain. Below that, a reorg can re-order. |

**Knob:** the per-network `finalityBlocks` integer lives in `chains.json` and is loaded into the registry at boot. The settler reads it; the indexer's reconciliation path (post-v1) reads it.

## 2 · Arc finality decision — **`finalityBlocks = 64`** for testnet

- Arc is a fast L1 (~250–500 ms block time per the public scorecard). It is **post-merge style** finality semantics: the chain exposes `finalized` and `safe` block tags via RPC, but until we have first-hand testnet observation of reorg depths, we use a conservative confirmation count.
- **64 blocks ≈ 16–32 seconds** at Arc's stated block time. This is well above any reorg depth we expect on a healthy L1 and gives us margin if validator latency spikes.
- **Mainnet decision is NOT made here.** WP-MN-04 ships testnet only. The mainnet `finalityBlocks` is set in a follow-up after we observe testnet behavior under load for 1 week minimum. Default proposal for mainnet: same as testnet until proven otherwise.
- **`chains.json` action:** WP-MN-04 T1 fills `arc-testnet.finalityBlocks = 64` and `arc-testnet.blockTimeMs = 500` (conservative upper bound; tightens with observation).
- **Fallback if testnet RPC exposes the `finalized` tag reliably:** still wait `finalityBlocks` blocks ourselves. Trusting the tag alone couples our correctness to an RPC node's view; the depth-count is a backstop that survives a single-node lag.

**Rationale for over-conservatism on first boot:** indexer-rollback bugs are silent. The cost of waiting 30s for finality is one HTTP-push latency; the cost of ingesting a re-orged settlement is a wrong `PoolState.balance` in the dashboard and wrong `RecipientEarnings.totalEarned` in the read API. We pay the latency.

## 3 · Gas estimation strategy — **EIP-1559 primary, legacy fallback**

Arc supports EIP-1559 (`baseFeePerGas` in the block header). The settler's EVM signer uses:

1. **Primary path:** `viem.estimateFeesPerGas({ chain })` returns `{ maxFeePerGas, maxPriorityFeePerGas }`. We accept whatever viem returns and add a **+20% buffer on `maxFeePerGas`** to absorb base-fee spikes during the `finalityBlocks` wait. `maxPriorityFeePerGas` is unbuffered (it's a tip; over-tipping wastes USDC).
2. **Fallback path (RPC node refuses EIP-1559):** `viem.estimateGas` → legacy `gasPrice = eth_gasPrice * 1.2`. WP-MN-04 RESEARCH validates Arc Testnet returns 1559 fees; this branch exists for defense-in-depth and for future EVM networks that may regress.
3. **Gas limit:** `viem.estimateGas` for the calldata, +30% safety margin (settle batches with N events vary; we'd rather over-fund than revert). The settler holds gas-token in the EOA wallet (Arc's USDC-is-native quirk — covered by `ProtocolInvariants.sol`'s `decimals() == 6` guard).
4. **Failure handling:** if `estimateGas` reverts (e.g., on-chain `DuplicateCallId` would revert), the settler logs the revert reason from `decodeRevertReason` (`protocol-evm-v1-client/src/errors.ts`) and DOES NOT broadcast. The batch is dropped, the indexer receives no push, and the original `SettlementEvent` goes back on the queue with the retry-count incremented. (Same model as today's Solana path which surfaces program errors before broadcast.)

**Why no max-gas-price ceiling at this phase:** testnet gas spikes don't happen at scale we'd notice. Mainnet gets a hard ceiling (`PACT_EVM_MAX_FEE_PER_GAS_WEI` env, settler refuses to broadcast above it) — that decision is its own follow-up doc.

## 4 · Idempotency key change — **`(network, callId)` supersedes `signature`**

The indexer's `EventsService.ingest()` currently uses Prisma's `@@unique([signature, callId])` on the `Settlement` table as the dedup key. Under EVM reorgs, `signature` (= `txHash`) is not stable. WP-MN-03a already added the `network` column and composite PKs; this section locks the dedup semantics on top:

- **The dedup key is `(network, callId)`.** A single agent call has exactly one logical settlement per network. If we see two pushes for the same `(network, callId)`, the second is a duplicate regardless of `txHash`.
- The `Settlement` model already has `@@id([network, signature, callId])`. This is the **storage** key, not the **dedup** key. For ingest:
  - **Lookup:** `findFirst({ where: { network, callId } })`. If row exists, return 200 idempotent (no double-write).
  - **Insert:** the new row carries the current `txHash` as `signature`. If the on-chain settlement is later re-orged and resubmitted under a new `txHash`, the second push is rejected at `findFirst` time (same callId).
- **`SettlementRecipientShare` and `RecipientEarnings`** follow the same rule: a successful insert is gated on the parent `Settlement.findFirst` returning null. If a reorg-replay sneaks past (race condition during the finality wait), the on-chain `DuplicateCallId` revert is the second-line defense and the second tx never lands.
- **Migration impact:** **none on the schema** — the schema already supports this; the change is in `EventsService.ingest()`'s lookup-before-insert logic. Tracked as WP-MN-04 T3 sub-task.

**What about `signature` collisions across networks?** A `txHash` on Arc and a `signature` on Solana can theoretically collide (both are 32-byte hex/base58 derivatives). The composite `(network, signature, callId)` storage key already handles this; the dedup change is orthogonal.

## 5 · Reorg-rollback path — **soft-reorg-tolerant ingest; hard-reorg manual**

Two distinct cases:

### 5.1 Soft reorg (depth ≤ `finalityBlocks`)

By construction, the settler does not push to the indexer until the receipt has `finalityBlocks` confirmations. So **the indexer never sees a sub-finality event from the settler push.** The settler's wait loop is the sole defense.

**Settler wait-loop algorithm (WP-MN-04 T2):**

```
broadcast(tx) -> txHash
loop:
  receipt = getReceipt(txHash)
  if receipt is null: sleep(blockTimeMs); continue
  if receipt.status == reverted: log + drop batch; return failure to queue
  current = getBlockNumber()
  depth = current - receipt.blockNumber + 1
  if depth >= finalityBlocks:
    return success(txHash, receipt)
  sleep(blockTimeMs)
```

If during the wait the `receipt.blockHash` changes (sub-finality reorg dropped our tx), the next `getReceipt(txHash)` returns null → loop continues. If the tx is permanently dropped (not just replaced under a new hash, but the nonce was replayed by a different tx), `viem.waitForTransactionReceipt` with a `timeout` of `finalityBlocks * blockTimeMs * 3` throws → we log + drop + back-to-queue with retry.

### 5.2 Hard reorg (depth > `finalityBlocks` — should not happen on healthy network)

If a chain reorg exceeds `finalityBlocks` (rare; usually a network incident), the indexer has already ingested rows that no longer reflect the canonical chain. WP-MN-04 ships an **operator-driven manual reconciliation** path, NOT an automatic one:

1. **Detection:** the optional `tailSettlementEvents()` adapter method (run by a cron, post-v1) re-reads finalized `CallSettled` events from the last 24h. For each event in canonical chain: lookup `(network, callId)`. For each `(network, callId)` in DB **without** a canonical-chain event: row is orphaned.
2. **Alert:** orphaned rows are flagged in a `settlement_reorg_audit` view (read-only). No automatic deletion.
3. **Manual rollback:** operator (Tu) runs `pnpm --filter @pact-network/indexer reorg:rollback --network arc-testnet --call-id <id>` which:
   - Decrements `PoolState.balance` by the orphaned `Settlement.amount`.
   - Decrements `RecipientEarnings.totalEarned` for each `SettlementRecipientShare`.
   - Deletes the orphaned `Settlement` and its shares.
   - Logs the rollback to `OperatorAuditLog`.
4. **WP-MN-04 ships:** the `tailSettlementEvents()` impl (optional method on EvmAdapter), the audit view migration, and the manual rollback CLI. NOT an auto-rollback daemon.

**Why manual:** hard reorgs on a healthy L1 are network-incident-grade events that warrant human eyes. Auto-rollback could amplify a misclassification bug into mass data loss. We can graduate to auto-rollback after 6 months of operator-driven experience.

## 6 · Per-VM auth (off-chain §2.5 implementation lock)

The off-chain spec §2.5 already specifies the shape; this doc locks the implementation for Arc:

| Concern | Arc-Testnet implementation |
|---|---|
| Settler EOA secret | Google Secret Manager, key name `pact-settler-arc-testnet`. Value is 0x-prefixed hex private key. Loaded by NestJS via `secret-loader` (new EVM branch). Held in `WalletClient` instance, never written to disk or logs. |
| EOA address derivation | `privateKeyToAccount(hex).address` at settler boot. Logged once. Granted `SETTLER_ROLE` on `PactSettler` via a separate Tu-signed admin tx pre-fleet-boot. |
| Rotation procedure | 1. Generate new key. 2. Store in Secret Manager. 3. Tu signs `grantRole(SETTLER_ROLE, newAddr)`. 4. Cloud Run env update pointing to new secret. 5. Restart settler. 6. Tu signs `revokeRole(SETTLER_ROLE, oldAddr)`. 7. Delete old secret after 1 week. No contract change. |
| Ops signature verify | EIP-191 personal-sign for v1 (matches MetaMask / WalletConnect default). EIP-4361 (SIWE) deferred to v2. `adapter.verifyOpsSignature` impl uses `viem.verifyMessage`. |
| Allowlist columns | `OperatorAllowlist.walletPubkey @db.VarChar(44)` widens to `VarChar(64)` in WP-MN-04 T4 to accept both base58-44 and hex-42 (0x-prefixed). |

## 7 · What this policy does NOT cover (out of scope, future work)

- **Mainnet `finalityBlocks` tuning** — done after 1 week of testnet observation, separate doc.
- **Mainnet gas-price ceiling (`PACT_EVM_MAX_FEE_PER_GAS_WEI`)** — separate doc, blocking mainnet ramp.
- **Multi-EVM-chain mixed fleet** — only Arc Testnet in WP-MN-04. 0G / Base / future EVMs reuse the same policy but require their own `finalityBlocks` decision before fleet boot.
- **Automatic hard-reorg rollback daemon** — deferred minimum 6 months.
- **Optimistic L2 finality (e.g., Base)** — Arc is L1; the `finalityBlocks` model holds. Optimistic L2s need a different doc (7-day challenge window vs N-block confirmation).
- **MEV resistance / private mempool** — not a v1 concern on Arc (no public mempool yet).
- **Sybil resistance on the `SETTLER_ROLE` allowlist** — covered by Tu-as-admin model; multisig rotation pre-mainnet is in `docs/audits/2026-05-05-mainnet-readiness.md`.

## 8 · Sign-off

| Role | Name | Status |
|---|---|---|
| Captain (project owner) | Tu | PENDING — this doc is the WP-MN-04 Gate A entry artifact; Tu reviews before authorizing T1. |
| Captain-proxy author | (this session) | Authored 2026-05-20. |
| Implementation owner (settler EVM auth) | WP-MN-04 T2 | Will reference §6 verbatim. |
| Implementation owner (indexer dedup) | WP-MN-04 T3 | Will reference §4 verbatim. |
| Implementation owner (reorg-rollback CLI) | WP-MN-04 T3.5 | Will reference §5.2 verbatim. |

## Appendix A — Numbers at a glance

| Knob | Arc Testnet | Notes |
|---|---|---|
| `finalityBlocks` | 64 | ~16–32s wait. Tightens with observation. |
| `blockTimeMs` | 500 | Conservative upper bound. |
| `maxFeePerGas` buffer | +20% over `estimateFeesPerGas` | Absorbs base-fee spike during finality wait. |
| `gasLimit` buffer | +30% over `estimateGas` | Settle-batch size varies. |
| Settle wait timeout | `finalityBlocks * blockTimeMs * 3` = ~96s | Past this, drop batch + retry. |
| Reconcile-tail interval | 1h (cron) | Post-v1 reconciliation, not primary path. |
| Hard-reorg audit window | 24h | `tailSettlementEvents` re-scan range. |

## Appendix B — How this policy gates WP-MN-04 RESEARCH

WP-MN-04 RESEARCH (`mn-04-RESEARCH.md`) references this doc in:
- §3 (EvmAdapter `submitSettleBatch` algorithm) — implements §5.1's wait loop.
- §4 (indexer `EventsService.ingest` change) — implements §4's `(network, callId)` lookup.
- §5 (settler EOA secret loading) — implements §6's `pact-settler-arc-testnet` model.
- §6 (`chains.json` fill) — implements §2's `finalityBlocks=64`, `blockTimeMs=500`.
- §7 (reorg-rollback CLI) — implements §5.2's manual procedure.

If any of those sections in RESEARCH contradicts this policy, RESEARCH amends to match — this doc is the source of truth.
