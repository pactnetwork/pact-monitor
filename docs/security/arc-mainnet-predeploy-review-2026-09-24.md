# Pact Network `protocol-evm-v1` — Arc Mainnet Pre-Deploy Security Review

**Date:** 2026-09-24
**Reviewer:** AI-assisted review (blockchain-security-auditor persona), branch `feat/arc-mainnet-registry`
**Scope:** `packages/program-evm/protocol-evm-v1/` (PactRegistry, PactPool, PactSettler, FeeValidation, Deploy.s.sol), `packages/protocol-evm-v1-client/`, and the settler/indexer off-chain code that talks to these contracts on Arc.

> **This is an internal AI-assisted review. It is NOT a substitute for an external, human-led smart-contract audit.** `protocol-evm-v1` has never had a third-party audit. Do not present this document as an audit in the grant application or to any counterparty — call it what it is: an internal pre-deploy check.

## Verdict: **NOT SAFE FOR MAINNET** (SAFE WITH FIXES, but the fix is not optional)

One Critical finding (C-01) makes this contract set unsafe to fund with real USDC as currently structured: a single non-rotatable EOA can drain any endpoint's entire pool balance in a handful of transactions, with no multisig, timelock, or recovery path. Everything else found is High/Medium/Low and does not block a fix-and-ship path. Do the C-01 fix (change one constructor argument at deploy time — no contract code change needed) before any real USDC touches the pool.

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 2 |
| Medium | 2 |
| Low | 3 |
| Informational (Arc-risk checklist, cleared) | 6 |

---

## Critical

### C-01 — `authority` is a single, non-rotatable EOA that can drain any endpoint's entire pool in one settlement, and the contracts as written give it no rotation path

**Files:** `src/PactRegistry.sol:32,47-50,56-77,156-173,206-209`; `src/PactPool.sol:19-36,135-137`; `src/PactSettler.sol:25-54,60-149`; `script/Deploy.s.sol:29-35,108-119`

`PactRegistry.authority` is set once in the constructor and never has a setter — grep confirms there is no `setAuthority`/`transferAuthority`/`Ownable2Step`/timelock anywhere in the three locked contracts. `Deploy.s.sol`'s own comment states the plan explicitly: *"`authority_` IS the deployer EOA, full stop... A separate/rotated authority is OUT OF SCOPE for WP-07 (later mainnet authority-rotation concern, a post-deploy transfer step, not a ctor arg). There is intentionally NO separate-authority branch here."* That "later" step never got built — there is no mechanism to execute it short of a full redeploy.

That single `authority` EOA holds `DEFAULT_ADMIN_ROLE` on **all three** contracts (Registry, Pool, Settler — each contract's constructor grants it independently) and, via `onlyAuthority`, exclusively controls `registerEndpoint`, `updateEndpointConfig` (including `exposureCapPerHour`, which has **no upper bound check anywhere**), `updateFeeRecipients`, `pauseEndpoint`, and `pauseProtocol`.

**Concrete attack, given only the `authority` private key (no need to also compromise the separate settler-bot key):**
1. `registry.updateEndpointConfig(slug, ..., exposureCapPerHour: type(uint64).max)` on any already-funded, registered endpoint — removes the only economic circuit breaker (`recordCallAndCapAccrual`'s cap-clamp in `PactRegistry.sol:270-277` becomes a no-op once the cap exceeds the pool balance).
2. `PactSettler(settler).grantRole(SETTLER_ROLE, attacker)` — `authority` holds `DEFAULT_ADMIN_ROLE` on `PactSettler`, which by default OZ `AccessControl` semantics can grant any role on that contract, including to itself.
3. From the attacker's own EOA (now holding `SETTLER_ROLE` on `PactSettler`), approve a trivial USDC amount (`MIN_PREMIUM` = 100 base units = $0.0001) from that same EOA to... actually no approval to attacker needed beyond the standard ERC-20 allowance the attacker sets on their own wallet for the Settler to pull from — call `settleBatch([{ callId: <any unused id>, agent: attacker, endpointSlug: slug, premium: 100, refund: <pool's full USDC balance>, breach: true, ... }])`.
4. `PactSettler._settleSuccess` pulls the $0.0001 premium (succeeds, `premiumInOk = true`), credits it to the pool, then pays the fabricated refund to `ev.agent` = attacker, capped only by the pool's actual `currentBalance` (`PactPool.sol:119-130`, `PactSettler.sol:217-239`) — which after step 1 is the entire pool.

Net cost to the attacker: gas + $0.0001. Net theft: the endpoint's entire pool balance, in one `settleBatch` transaction. This is not a multi-day, multi-precondition attack — it's minutes of work once the key leaks, and it requires **no bug** beyond "the admin key does what an admin key can do, and nothing gates or delays that."

Because the contracts are non-upgradeable ("LOCKED" per the file headers) and `authority`/`treasuryVault`/`maxTotalFeeBps` have no setters, this cannot be patched post-deploy — only prevented at deploy time.

**Fix (no Solidity change required):** at deploy time, pass a real multisig (e.g., a Safe with a sane signer threshold) as the `authority_` constructor argument instead of the deployer EOA — `Deploy.s.sol:108` currently hardcodes `deployer` for this. If you want the deployer EOA to be able to finish setup (grant `SETTLER_ROLE` to the settler contract, register the first endpoint) before handing off, either (a) do that setup from the multisig directly (Safe supports contract calls), or (b) accept the one-time centralization window between deploy and the multisig's first admin action, but do **not** fund any pool with real USDC until the multisig is confirmed as `authority` and the deployer key's role grants have been revoked. As defense-in-depth, also add an upper bound (or a timelock on increases) to `exposureCapPerHour` in `updateEndpointConfig`/`registerEndpoint` so a compromised or careless admin action can't instantly remove the only per-endpoint spending limit in the system.

This is not novel to the EVM port — it mirrors the Solana v1 program's own authority/settlement-signer model, which `CLAUDE.md` already flags as "BLOCKED FOR MAINNET pending multisig rotation" for that chain. That referenced audit file (`docs/audits/2026-05-05-mainnet-readiness.md`) does not exist in this checkout (only unrelated dead-code-prune audits are present under `docs/audits/`), so it's unclear whether Solana's version of this issue was ever actually resolved — worth checking before treating Solana mainnet as a safe precedent. Either way, it does not make the Arc EVM deploy safe by association.

---

## High

### H-01 — `SETTLER_ROLE` is an unverified off-chain oracle that can drain any endpoint's pool up to `exposureCapPerHour`, with the key currently stored as a plaintext Cloud Run env var

**Files:** `src/PactSettler.sol:60-149`; `docs/evm/2026-05-20-reorg-policy.md:100-115` (§6)

Independent of C-01, the design's core trust assumption is that whoever holds `SETTLER_ROLE` on `PactSettler` tells the truth about `breach`/`refund` — there is no on-chain proof of an actual SLA breach (no oracle, no signed attestation from the insured endpoint, nothing). A compromised or dishonest settler-bot key can fabricate breach events for any real, funded endpoint and drain up to that endpoint's `exposureCapPerHour` per rolling ~hour window, indefinitely, to any address — using the same self-approval trick as C-01 step 3, without ever touching the `authority` key.

Per `docs/evm/2026-05-20-reorg-policy.md` §6, the settler's EVM private key is Phase-1-stored as a raw 0x-prefixed hex value directly in a Cloud Run env var (not Secret Manager) — "Phase 2 is tracked as a follow-up Rick-owned ops task." Confirm before mainnet whether Phase 2 has landed for the Arc settler key specifically; if not, that plaintext env var is the actual attack surface for this finding, not a contract bug.

This mirrors a known limitation of the whole Pact design (same shape as the Solana settler key) rather than something introduced by the EVM port, but it is a real single-key drain vector for real mainnet USDC and should be sized to it: keep `exposureCapPerHour` conservative relative to actual pool funding for the initial mainnet grant-demo call (small caps, small pools), and move the settler key to Secret Manager before mainnet if it hasn't already.

**Fix:** (1) confirm/complete the Secret Manager migration for the Arc settler key before mainnet; (2) set `exposureCapPerHour` deliberately low relative to the initial pool size for the demo endpoint(s) — the cap is your only on-chain damage limiter today; (3) longer-term, consider requiring a second signer or a short delay/challenge window on refunds above a threshold, since `pauseEndpoint`/`pauseProtocol` only stop *future* `settleBatch` calls — they cannot claw back a refund already paid out by a malicious or buggy batch.

### H-02 — `config/chains.json` has no `arc-mainnet` entry; `Deploy.s.sol` cannot target Arc mainnet today

**Files:** `packages/program-evm/protocol-evm-v1/config/chains.json`; `packages/program-evm/protocol-evm-v1/script/Deploy.s.sol:52-70`

`chains.json` defines `arc-testnet`, `base-sepolia`, `base-mainnet`, `arbitrum-sepolia` — no `arc-mainnet` (chain id 5042). `Deploy.s.sol` resolves the target chain by scanning this file and `require`s a match (`Deploy.s.sol:67-70`); running the script against `CHAIN_ID=5042` today reverts with `CHAIN_ID 5042 not in chains.json` before any contract is even attempted.

Separately, `packages/protocol-evm-v1-client/src/constants.ts:40-44` **already** defines an `arc-mainnet` entry (chainId 5042, USDC `0x3600000000000000000000000000000000000000`) — and that USDC address is independently confirmed correct (team memory records an `eth_call` decimals check against Arc mainnet on 2026-09-23 returning 6, consistent with this address). So the client's guess is right, but it's currently **untested**: `__tests__/chain-table-drift.test.ts` only asserts drift between `chains.json` and `constants.ts` for arc-testnet/base-sepolia/base-mainnet — it never checks `arc-mainnet`, so a future edit to either file could silently diverge (wrong USDC address baked into the client) without CI catching it.

This is a blocker for actually running the planned deploy, not an exploitable vulnerability — the deploy script fails safe (revert, not wrong-token deploy). Your branch is literally named `feat/arc-mainnet-registry` and a teammate agent by that name appears to be active in this session, so this may already be in flight; flagging in case it isn't.

**Fix:** add an `arc-mainnet` entry to `config/chains.json` (chainId `5042`, `usdcAddress: 0x3600000000000000000000000000000000000000`, `usdcDecimals: 6`, plus a `finalityBlocks`/`blockTimeMs` per the mainnet finality follow-up — see Informational-6 below), and extend `chain-table-drift.test.ts` to cover `arc-mainnet` the same way it covers the other three chains so this can't silently drift again.

---

## Medium

### M-01 — `treasuryVault` and `maxTotalFeeBps` are permanent, with no rotation path

**Files:** `src/PactRegistry.sol:34-35,56-77`; `script/Deploy.s.sol:37-43` (C2)

Both are constructor-only, by deliberate design ("C2 GATE A verdict... NO setter — permanent for the life of the deployment," ratification required "BEFORE broadcast"). Not a fund-drain risk on its own (fee share is capped at `maxTotalFeeBps`, default 3000 bps = 30% of premium, not of pool balance), but if the treasury address is ever compromised, lost, or simply needs to move to a proper multisig later, there is no on-chain path except a full redeploy. Since this is already a ratified, deliberate decision, the only actionable ask is: **make sure the `TREASURY_VAULT_ADDRESS` used for the actual mainnet deploy is a multisig, not a hot EOA**, since day-two rotation isn't possible.

### M-02 — No reentrancy guard on `PactPool`/`PactSettler`, relying entirely on USDC having no transfer hooks

**Files:** `src/PactPool.sol:135-137` (`payout`), `src/PactSettler.sol:113-142` (`transferFrom` in a try/catch inside a loop)

Every external call in the settlement path is a plain ERC-20 `transfer`/`transferFrom` on the Arc USDC contract, which (per Arc's own docs) is a standard token, not ERC-777/1363 — no callback hook fires on the recipient, so there's no reentrancy vector today. But there's also no `ReentrancyGuard` anywhere as defense-in-depth, on a chain and token pairing that hasn't had years of adversarial mainnet exposure the way Ethereum mainnet USDC has. Low cost, cheap insurance.

**Fix:** add OZ `ReentrancyGuard` (`nonReentrant`) to `PactPool.payout`/`PactSettler.settleBatch` before mainnet. Non-blocking given the current token's confirmed hook-free behavior, but cheap enough to just do.

---

## Low

### L-01 — `exposureCapPerHour` period reset is wall-clock, not rolling, allowing a ~2x burst right at the period boundary

**File:** `src/PactRegistry.sol:259-263`

`if (uint64(block.timestamp) > ep.currentPeriodStart + 3600) { currentPeriodStart = now; currentPeriodRefunds = 0; }`. Whoever controls `SETTLER_ROLE` (see H-01) can drain up to the cap, wait for the period to roll (as little as 1 second if timed at the boundary), then drain up to the cap again — effectively up to ~2x the intended hourly cap in a short window. Still bounded by the cap value and actual pool balance, so this compounds H-01's ceiling rather than removing it. Low priority; note it if `exposureCapPerHour` tuning assumes a hard hourly ceiling.

### L-02 — No emergency-pause recovery for funds already paid out

**Files:** `src/PactRegistry.sol:196-209`; `src/PactSettler.sol:65-70`

`pauseEndpoint`/`pauseProtocol` block *future* `settleBatch` calls but cannot reverse a refund already paid by a prior (malicious or buggy) batch. This is standard for this class of design and not a code defect, just worth stating plainly given C-01/H-01: pausing is incident containment, not recovery.

### L-03 — Non-upgradeable by design; any future fix (including C-01) requires redeploy + manual balance migration

**Files:** all three contracts — no proxy pattern, straightforward constructors, comments explicitly call them "LOCKED."

Deliberate v1 tradeoff (simpler attack surface, no proxy-storage-collision risk), but means there is currently zero in-place remediation path for anything found in this review or discovered later. Worth knowing going in, not something to fix now.

---

## Informational — Arc-specific risk checklist (verified against `docs.arc.io`, 2026-09-24)

1. **Native gas token is 18-decimal USDC, separate from the 6-decimal ERC-20 USDC interface** (confirmed, `docs.arc.io/arc/concepts/stablecoin-native-model`). **No bug found** — the contracts never touch the native balance at all; every amount (`premium`, `refund`, fee shares) flows through the 6-decimal ERC-20 `usdc` token exclusively, and `Deploy.s.sol:88-92` asserts `IERC20Metadata(usdc).decimals() == 6` before construction. `packages/settler/src/health/signer-balance.service.ts` (flagged in the task brief) correctly separates `LAMPORTS_PER_SOL` (Solana) from `WEI_PER_NATIVE` (EVM native gas, 18-decimal) and only uses the native-wei path for the settler's own gas-tank health check, never for premium/refund math — no decimal conflation found there either.

2. **Minimum base fee 20 gwei; sub-floor txs are silently dropped, not reverted** (confirmed, `docs.arc.io/arc/references/gas-and-fees`: "Transactions submitted under this floor may remain pending indefinitely or fail outright," error `transaction underpriced`). The settler's wait-loop (`docs/evm/2026-05-20-reorg-policy.md` §5.1, implemented in `packages/shared/src/adapters/evm/index.ts`) already treats "no receipt after a bounded timeout" as drop-and-retry rather than assuming a revert is visible, so this is handled by design. Since the fee estimator (`viem.estimateFeesPerGas`, +20% buffer) reads the chain's live base fee, it will track above the 20 gwei floor automatically as long as the RPC node reports it correctly. **No bug found**, but worth a smoke-test on real Arc mainnet RPC before go-live to confirm `estimateFeesPerGas` isn't silently returning a stale/low value from a lagging node.

3. **`PREVRANDAO`/`block.difficulty` fixed at 0 on Arc** (confirmed, community sources; not independently reachable on docs.arc.io during this review). Grepped the entire contract tree and its OpenZeppelin dependencies (`AccessControl`, `IERC20`, `SafeERC20`) — **zero references** to `prevrandao` or `block.difficulty` anywhere. Not applicable.

4. **No EIP-4844 blobs on Arc.** No blob-related code (blob transactions, `blobhash`, versioned hashes) anywhere in this codebase. Not applicable.

5. **EIP-7708 native-transfer logs come from a system emitter, not the transferring address.** Confirmed via `docs.arc.io/arc/concepts/stablecoin-native-model`: an ERC-20 USDC `transfer`/`transferFrom` on Arc emits **two** logs — a standard 6-decimal `Transfer` from the USDC contract itself, **and** an 18-decimal EIP-7708 log from a separate system emitter; Arc's own docs warn integrators to "match on the emitter address to avoid double-counting." Grepped indexer + shared EVM adapter code for any USDC-contract log watching — **none exists**. Pact's off-chain code only decodes `PactEvents`/`IPactSettler.CallSettled` logs emitted by the Pact contracts themselves (`decodePactEventLog` in `packages/shared/src/adapters/evm/index.ts:727`), which are ordinary single-emitter logs unaffected by this quirk. **No bug found.**

6. **Deploys are permissionless on Arc.** `Deploy.s.sol` takes an arbitrary `DEPLOYER_PRIVATE_KEY` and makes no assumption about a whitelisted/privileged deployer identity. **No bug found.**

7. **Reorg depth / finality.** Verified via `docs.arc.io/arc/concepts/deterministic-finality` and `docs.arc.io/arc/concepts/consensus-layer`: Arc runs a Tendermint/Malachite BFT proof-of-authority consensus with ~20 SOC2-certified validators; finality is **deterministic and sub-second** (under 1 second) once 2/3+ of validators sign a block — there is no probabilistic reorg risk once a block is committed, unlike Ethereum-style longest-chain consensus. This is a materially different (and stronger) guarantee than the testnet policy's conservative `finalityBlocks = 64` (~16-32s wait) assumes. Handing this to whoever owns the mainnet finality-depth follow-up doc (`docs/evm/2026-05-20-reorg-policy.md` §7 lists it as a separate, not-yet-written doc): the current 64-block wait is safe to carry forward as a starting point (errs conservative, not permissive) but can very likely be tightened substantially once mainnet is confirmed to expose the same BFT guarantees as advertised. Not my task to change; not a blocker.

**Also checked, not on the Arc-specific list:** the mainnet gas-price ceiling that `docs/evm/2026-05-20-reorg-policy.md` (dated 2026-05-20) describes as "blocking mainnet ramp" and "not yet implemented" **has since been implemented** — `packages/shared/src/adapters/evm/index.ts` has a `maxFeePerGasWei` option that refuses to broadcast above the ceiling, wired via `PACT_EVM_MAX_FEE_PER_GAS_WEI[_<NETWORK>]` in `packages/settler/src/adapters/adapters.service.ts:90,205-211`. It's optional (no ceiling if the env var is unset), so the remaining action is operational — **set `PACT_EVM_MAX_FEE_PER_GAS_WEI_ARC_MAINNET` before launch** — not a missing code path. Its current absence-if-unset is a gas-cost/liveness risk (the settler could overpay during a fee spike, or exhaust its own gas wallet faster than expected), not a pool-fund-loss vector — the pool's USDC is never used to pay gas.

---

## Summary for the grant deadline conversation

The contracts correctly avoid the decimal-conflation, blob, and PREVRANDAO traps this review specifically looked for on Arc — that part of the port is solid. The blocker is not an EVM-specific bug; it's the same centralization gap the Solana side is already flagged for: **one EOA with no rotation path controls everything, and can turn that control into a full pool drain in a few transactions.** That is fixable **without touching contract code** — set `authority_` to a real multisig at deploy time in `Deploy.s.sol`, and don't fund any pool until that multisig is confirmed in place. Everything else here is worth doing but doesn't have to block Wednesday.
