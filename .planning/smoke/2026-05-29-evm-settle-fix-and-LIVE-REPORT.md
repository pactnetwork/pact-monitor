# EVM Settle Send-Raw-Transaction Fix + LIVE Closed-Loop Proof — 2026-05-29

- **Branch:** `fix/evm-settle-send-raw-transaction` (off `feat/multi-network` @ `f538749`)
- **Fix commit:** `a8afaea` — `fix(shared): EVM settler signs settleBatch locally via eth_sendRawTransaction`
- **Operator:** captain-delegated crew (local pnpm workspace)
- **Scope guarantee:** the ONLY committed change is the adapter fix + its unit test. All smoke-only edits reverted; final `git status` shows only `.planning/` untracked.

## Verdict: **GREEN on BOTH chains.** Real Jupiter call → premium → on-chain `settleBatch` via `eth_sendRawTransaction`, exact fee split verified.

| Chain | Real upstream 200 | Premium event | Settle tx | Fee split exact? | Verdict |
|-------|-------------------|---------------|-----------|------------------|---------|
| **arc-testnet** (5042002) | Jupiter `/price/v3` 200 | `6858337c…` premium 10000 `ok` | [`0x08060bc0…de93fe`](#) success, eip1559 | agent −10000 / pool +8500 / affiliate +500 exact; treasury +1000 (net of gas¹) | **GREEN** |
| **base-sepolia** (84532) | Jupiter `/price/v3` 200 | `35f7e1ab…` premium 10000 `ok` | [`0xc480a7ca…440c`](#) success, eip1559 | agent −10000 / pool +8500 / treasury +1000 / affiliate +500 **all exact** | **GREEN** |

¹ On Arc (USDC-native L1) the gas token *is* USDC, and the endpoint's treasury recipient happens to be the same address as the settler signer (`0x777…`), so the treasury account's USDC delta = +1000 fee − gas. The three independent accounts (agent, pool, affiliate) confirm the split exactly; base-sepolia (gas = ETH, distinct from USDC) shows treasury +1000 cleanly.

---

## 1. The bug

`packages/shared/src/adapters/evm/index.ts`, `EvmAdapter.submitSettleBatch`. The send call passed `account: account.address` — a bare **address string** — to viem's `walletClient.sendTransaction`. viem treats an address-string account as a **JSON-RPC / node-managed** account and emits `eth_sendTransaction` / `wallet_sendTransaction`, asking the RPC node to sign. Public testnet RPCs have no unlocked accounts and reject that method.

**Reproduced** from the prior run's `settler-arc529.log` (line 59 / 69):
```
[BatcherService] Flush group "["arc-testnet","e2e-test-slug-01"]" failed: settleBatch send failed: RPC Request failed.
Request body: {"method":"wallet_sendTransaction","params":[{ ... "from":"0x777d569…", ... }]}
Details: this request method is not supported
```
The `walletClient` was already constructed with a **local** `privateKeyToAccount` (constructor, ~line 196), so the signer material is in-process; only the send call mis-passed `.address`.

## 2. The fix (diff summary)

Pass the local `PrivateKeyAccount` **object** (not `.address`) so viem signs locally and submits via `eth_sendRawTransaction`:

```diff
-    // Send transaction
+    // Send transaction. Pass the LOCAL account OBJECT (not account.address):
+    // viem treats a bare-address account as JSON-RPC/node-managed and emits
+    // eth_sendTransaction/wallet_sendTransaction (the RPC node signs). Some RPCs
+    // (e.g. Arc Testnet) reject that method ("request method is not supported").
+    // The object is the PrivateKeyAccount the walletClient was built with, so
+    // viem signs locally and submits via eth_sendRawTransaction.
     let txHash: Hex;
     try {
       txHash = await (this.walletClient.sendTransaction as (args: unknown) => Promise<Hex>)({
-        account: account.address,
+        account,
         to: settlerAddr,
```
The `estimateGas` call (~line 504) keeps `account.address` deliberately: `eth_estimateGas` is read-only (the address is only a `from` hint, no signing) and succeeded in the failing log — not part of the bug. Surgical: 1 functional line + comment.

A regression test was added to `packages/shared/test/evm-adapter-unit.test.ts` asserting the submit path receives the account **object** (local signing), not the bare address string.

## 3. Blast radius (impact analysis)

GitNexus's `pact-network` index is **not loaded** in this session's MCP instance (only `OnePlanApp, brove, claude-cockpit, pact-monitor` available), so `gitnexus_impact` could not run. Manual blast radius (grep + the GitNexus PreToolUse hint):

- `submitSettleBatch` is a `ChainAdapter` interface method (`chain-adapter.ts:159`), implemented by `SolanaAdapter` and `EvmAdapter`.
- Sole production caller: `SubmitterService.submitViaAdapter` → `submitter.service.ts:285` (`processBatch` path) — the shared multi-network submit path for arc + base + solana.
- The edit is **internal** to `EvmAdapter.submitSettleBatch`; no signature/interface change, Solana adapter untouched.
- **Risk: LOW.** The change only alters how viem receives the (already-local) account; strictly more correct, fixes all EVM chains. Below HIGH/CRITICAL → no stop-and-ask warranted.

## 4. Build + test results

- `pnpm --filter @pact-network/shared --filter @pact-network/settler build` → clean.
- `pnpm --filter @pact-network/shared test` → **53/53 pass** (8 files), including the new regression test (evm-adapter-unit: 22 → 23 tests).
- `pnpm --filter @pact-network/settler test` → 115 pass, **5 fail**. Verified **pre-existing** by stashing the fix and re-running the same two specs on the clean baseline — identical 5 failures (`Cannot convert 0x to a BigInt` at `index.ts:534`, a concurrency-test timeout). A stub transport returning `0x` for a numeric field; **not caused by this fix.**

## 5. LIVE closed-loop proof

**Boot (from freshly-built dist, command-line overlays only, no `.env` edits):**
`QUEUE_BACKEND=redis-streams REDIS_URL=redis://localhost:6380 REDIS_STREAM=pact-settle-events`; temp `postgres:16-alpine` `pact-pg-529` on **:5434** mounting the shared `pact-network_pgdata` volume, `PG_URL=postgresql://pact:pact@localhost:5434/pact`; indexer `PORT=3012`, proxy `:3003`, settler `INDEXER_URL=http://localhost:3012 PACT_RPC_URL_ARC_TESTNET=https://rpc.testnet.arc.network`. `oneplan-postgres` (:5433) untouched. All 3 services booted healthy; settler + indexer log `adapters bootstrapped: solana-devnet, base-sepolia, arc-testnet | legacyDirectSolana=false`.

**Routing path (documented deviation):** the task suggested mapping the slug to `jupiterHandler`, but `jupiter.ts` forwards `url.pathname` verbatim (`/v1/<slug>/…`), which 404s against Jupiter's REST `/price/*`. The **`dummyHandler` strips the `/v1/<slug>` prefix** and uses the same status-based `marketDefaultClassifier`, so it is the correct tool for a REST GET. Smoke map (reverted): `handlerRegistry["e2e-test-slug-01"] = dummyHandler` + matching `classifierRegistry` entry. Also note: Jupiter's `/price/v2` is now retired (404 "Route not found"); the live endpoint is **`/price/v3`** (real 200 JSON confirmed via curl + an uninsured proxy passthrough).

### arc-testnet
- Real GET `/v1/e2e-test-slug-01/price/v3?ids=So111…112` (EIP-191 v2-signed, agent `0x1c84…4760`) → Jupiter **200** → classifier `ok` → premium **10000** → redis event `6858337c-3429-4f94-aa50-14706f1321ff` (`network=arc-testnet`).
- Settler auto-flush → **`settleBatch` tx `0x08060bc0fa1163a297e9a9d57c0bc7c52f56b342269bf4999e2f37b169de93fe`** — status **success**, from `0x777…` (settler signer) → PactSettler `0xe461…`, **txType eip1559**, gasUsed 197983, 280+ confirmations.

| Account | Before | After | Δ | Expected |
|---------|--------|-------|---|----------|
| agent USDC | 19988890 | 19978890 | **−10000** | −10000 ✓ |
| pool | 67500 | 76000 | **+8500** | +8500 ✓ |
| affiliate `0xFc561C…` | 491673 | 492173 | **+500** | +500 ✓ |
| treasury `0x777…` | 19146642 | 19143681 | −2961 (= +1000 fee − ~3961 gas¹) | +1000 ✓ (net of gas) |

> Note: an earlier **synthetic** redis entry (`7348a8f1…`, from the prior run's injection) was also settled on-chain by the fix at boot (agent had already gone 19998890 → 19988890 before this baseline). The proof above is driven by the **real Jupiter call** `6858337c`, not the injection.

### base-sepolia
- `e2e-test-slug-01` was **not registered on-chain** on base. The settler signer `0x777…` **is the registry authority** on base (holds SETTLER_ROLE + ADMIN), so per the task's pre-authorized Option B I registered it (throwaway test registration, mirroring arc's config) — tx **`0xcda8703a21fa3165ff96736deda9634f295d4974b8eb643f25ce8564418d0f51`** (success, locally signed). Agent is funded (20 USDC, 1e11 allowance, ~0.001 ETH gas) — **no faucet/human needed.**
- Real GET `/v1/e2e-test-slug-01/price/v3?ids=So111…112` → Jupiter **200** → `ok` → premium **10000** → redis event `35f7e1ab-2902-4ba0-91e5-a8b8bc24d20c` (`network=base-sepolia`).
- Settler auto-flush → **`settleBatch` tx `0xc480a7ca4e08a69a0c62b214f524731a5524b664d2da96b8397dfac1d5fb440c`** — status **success**, from `0x777…` → PactSettler `0xe461…`, **txType eip1559**, gasUsed 252267.

| Account | Before | After | Δ | Expected |
|---------|--------|-------|---|----------|
| agent USDC | 20000000 | 19990000 | **−10000** | −10000 ✓ |
| pool | 0 | 8500 | **+8500** | +8500 ✓ |
| treasury `0x777…` | 20000000 | 20001000 | **+1000** | +1000 ✓ |
| affiliate `0xFc561C…` | 0 | 500 | **+500** | +500 ✓ |

Both `settleBatch` txs are **eip1559** type landed via `eth_sendRawTransaction` — the exact behavior the fix introduces. The pre-fix code (`wallet_sendTransaction`) would have failed on both RPCs (Arc rejects the method outright; base-sepolia public RPC has no node-managed account).

## 6. Mutations + reversions (all reverted)

| Mutation | Type | Reverted? |
|----------|------|-----------|
| `registry.ts` + `classifiers.ts` smoke map of `e2e-test-slug-01 → dummyHandler` | source (uncommitted) | ✅ `git checkout` — slug count 0 in both; `git status` clean |
| arc `Endpoint.upstreamBase` `rpc.testnet.arc.network` → `lite-api.jup.ag` | DB (shared volume) | ✅ reverted to `https://rpc.testnet.arc.network` |
| base-sepolia `e2e-test-slug-01` Endpoint row + dependents (Call, PoolState, Settlement `0xc480…`, SettlementRecipientShare) | DB (shared volume) | ✅ cascade-deleted; DB back to original 4 rows |
| `pact-pg-529` temp Postgres container (:5434) | docker | ✅ removed |
| indexer / proxy / settler processes | runtime | ✅ killed |
| **base-sepolia on-chain `registerEndpoint`** (`0xcda8703a…`) | on-chain (testnet) | ⚠️ **throwaway test registration, left in place** — no `unregister` exists (only `pauseEndpoint`); inert (DB row deleted, no committed handler references it). Listed per task. |

**Left untouched (as required):** `pact-redis-smoke` (:6380) container, `oneplan-postgres` (:5433). The redis stream retains this session's ACKed events (`6858337c`, `35f7e1ab`, `ae160bf0`) and prior-run entries — consistent with prior smoke runs; container not touched. arc `e2e` telemetry rows (Call/Settlement for `6858337c`) left as new telemetry on the pre-existing arc endpoint, consistent with prior runs.

## 7. Artifacts
- Fix branch: `fix/evm-settle-send-raw-transaction` (commit `a8afaea`).
- Smoke harnesses (uncommitted, `.planning/smoke/`): `evmfix529-balances.mjs`, `evmfix529-call.mjs`, `evmfix529-register-base.mjs`.
- Logs (`.planning/smoke/logs/`): `indexer-evmfix529.log`, `proxy-evmfix529.log`, `settler-evmfix529.log`, `arccall-evmfix529.log`, `basecall-evmfix529.log`, `register-base-evmfix529.log`.
- PR: see below (opened into `feat/multi-network`).
