# WP-EVM-07b — Live Economic E2E — GATE B Report

Date: 2026-05-19
Author: WP-EVM-07b crew
Status: EXECUTION COMPLETE — AWAITING 07b-CAPTAIN-GATE-B-VERDICT.md
Result: ALL 7 STEPS PASS. ZERO parity discrepancies vs settle_batch.rs.

---

## READY-TO-BROADCAST note (section-8 record, C5)

READY TO BROADCAST -- captain release PRE-GRANTED in
07b-CAPTAIN-GATE-A-VERDICT.md (verdict + user fund-moving GO both satisfied).
All pre-flight reads complete. .env confirmed gitignored (git check-ignore
PASS) and absent from git status. Throwaway keys written ONLY into the
gitignored .env, never echoed. Proceeded straight through steps 1-7 with
conditions C1-C6 folded in.

### Pre-flight read results (no gas, before any broadcast)

| Check | Result |
|-------|--------|
| registry.protocolPaused() | false |
| PactSettler has SETTLER_ROLE on registry | true |
| PactSettler has SETTLER_ROLE on pool | true |
| registry.authority() | 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859 (deployer) |
| PactSettler DEFAULT_ADMIN_ROLE holder == deployer | true |
| slug "e2e-test-slug-01" bytes16 | 0x6532652d746573742d736c75672d3031 |
| chain latest block timestamp (pre-flight) | 1779173035 |
| deployer USDC balance (pre-flight) | 19910942 (~19.91 USDC) |
| USDC decimals | 6 |
| SETTLER_ROLE hash | 0x6666bf5bfee463d10a7fc50448047f8a53b7762d7e28fbc5c643182785f3fd3f |

### Throwaway wallets (addresses only; keys are .env-only, never echoed — C1)

| Role | Address |
|------|---------|
| SETTLER_EOA (also affiliate dest) | 0xFc561C8D1258269b66Fb6ee6FF4AaE8745D622c6 |
| AGENT_EOA | 0x37a8a637137E645fB2C2653a848e0AeC0519eC7D |

C1 method: each wallet generated with a SINGLE shell command that parsed
`cast wallet new` inside the command and appended E2E_*_PRIVATE_KEY=... into
the gitignored .env; only the address was emitted to stdout. The key string
NEVER appears in any tool result, this report, or any commit.
C2 method: every SettlementEvent timestamp was derived from
`cast block latest --field timestamp` MINUS 30s. NO `$(date +%s)` used.

---

## All transaction hashes (chain 5042002, RPC https://rpc.testnet.arc.network)

| # | Action | Tx hash | Status |
|---|--------|---------|--------|
| F1 | Fund SETTLER_EOA 500000 | 0x7c96edbfd450b94854185904ce91219489ac59a007299e3121ab7ee0585dc4e1 | 0x1 |
| F2 | Fund AGENT_EOA 200000 | 0xf609f5eb8a2acb9cdb91f60db441cb50dcb4f26060752eae496b9dd099ea9694 | 0x1 |
| 1 | grantRole(SETTLER_ROLE,SETTLER_EOA) on PactSettler | 0xa7ffe96af735b384f305cf17c3e4a7036a2ab0fc5d1d6f1052dce484c29d071d | 0x1 |
| 2 | registerEndpoint (Treasury+Affiliate) | 0x1c918da4151480bd70e107c47c6c5a557aa8aa1ced794e7b33f4e725f90342bd | 0x1 |
| 3a | DEPLOYER approve POOL 50000 | 0x465e7e9efe15915f6a16cf93b5cf02645c309078ff295ac2c52d4fb4f21ad5cc | 0x1 |
| 3b | topUp(slug,50000) | 0x1855d8fcf0e7ae64ada5854b522765cb9e6d1810cf2d56245cf19093a727c602 | 0x1 |
| 4 | AGENT approve SETTLER 25000 | 0x547e59c80e8b16926c12504a229bc96354a18fa063cc7ac16c98302b6a60e197 | 0x1 |
| 5 | settleBatch PASS (callId ...01) | **0x5de62ff55be0bf55004eff5a8008fa7aec6c1c98e34c9738dac0021fa20c4461** | 0x1 |
| 6 | settleBatch BREACH (callId ...02) | **0x6014f63d9f2e4e34e0f3d6c3a785a9ff93446dc8d36ec1c1d21689efdd57b67f** | 0x1 |
| 7 | settleBatch replay (callId ...01) | reverted DuplicateCallId (0x4999df69) | revert (expected) |

Step 5 block 42968139 gasUsed 234215 (7 logs); step 6 block 42968231 gasUsed
257083 (9 logs); step 1 block 42967959.

---

## Decoded CallSettled events

CallSettled topic0: 0x6884720a8479645f77c753251ab0b8f919333116f952044ef1006b8a237473c5

### Step 5 (PASS)
| field | value | predicted | verdict |
|-------|-------|-----------|---------|
| callId | 0x...0001 | 0x...0001 | MATCH |
| slug | 0x6532652d746573742d736c75672d3031 | same | MATCH |
| agent | 0x37a8a637137e645fb2c2653a848e0aec0519ec7d | AGENT_EOA | MATCH |
| premium | 10000 | 10000 | MATCH |
| refund | 0 | 0 | MATCH |
| actualRefund | 0 | 0 | MATCH |
| status | 0 (Settled) | 0 (Settled) | MATCH |
| breach | 0 | false | MATCH |
| latencyMs | 500 | 500 | MATCH |
| timestamp | 1779173181 | chain-30 | MATCH |

### Step 6 (BREACH)
| field | value | predicted | verdict |
|-------|-------|-----------|---------|
| callId | 0x...0002 | 0x...0002 | MATCH |
| slug | 0x6532652d746573742d736c75672d3031 | same | MATCH |
| agent | 0x37a8a637137e645fb2c2653a848e0aec0519ec7d | AGENT_EOA | MATCH |
| premium | 10000 | 10000 | MATCH |
| refund | 8000 | 8000 | MATCH |
| actualRefund | 8000 | 8000 (not clamped/depleted) | MATCH |
| status | 0 (Settled) | 0 (Settled) | MATCH |
| breach | 1 | true | MATCH |
| latencyMs | 3000 | 3000 | MATCH |
| timestamp | 1779173234 | chain-30 | MATCH |

---

## C6 — RAW before/after USDC balances + literal integer deltas (HONEST, no net-interpret)

All values are raw USDC micro-units read via
`cast call USDC balanceOf(address)`. Arc gas is paid in USDC, so any address
that BROADCASTS a tx also loses gas. Only SETTLER_EOA broadcast the settle
txs; AGENT_EOA and DEPLOYER did NOT broadcast steps 5/6, so their settle
deltas are PURE economic (zero gas noise) — the cleanest parity evidence.

### Baseline timeline (raw)

| Address | post-funding (pre-1) | pre-5 (post step4) | post-5 | post-6 (FINAL) |
|---------|----------------------|--------------------|--------|----------------|
| DEPLOYER | 19208759 | 19150753 | 19151753 | 19152753 |
| SETTLER_EOA | 500000 | 500000 | 495815 | 491173 |
| AGENT_EOA | 200000 | 198891 | 188891 | 186891 |
| POOL (contract) | 0 | 50000 | 58500 | 59000 |

### Step 5 (PASS) literal deltas: post-5 minus pre-5

| Address | pre-5 | post-5 | delta | predicted | verdict |
|---------|-------|--------|-------|-----------|---------|
| AGENT_EOA | 198891 | 188891 | -10000 | -10000 (premium, no gas: not broadcaster) | MATCH |
| DEPLOYER (treasury) | 19150753 | 19151753 | +1000 | +1000 (treasury fee, no gas: not broadcaster) | MATCH |
| SETTLER_EOA | 500000 | 495815 | -4185 | +500 affiliate MINUS gas (broadcaster) | see note A |
| POOL (contract) | 50000 | 58500 | +8500 | +10000 -1000 -500 = +8500 | MATCH |

Note A (SETTLER_EOA, step 5): SETTLER_EOA is BOTH the affiliate recipient AND
the tx broadcaster (pays Arc gas in USDC). Raw delta -4185 = +500 affiliate
fee - 4685 gas. The +500 affiliate receipt is PROVEN independently by the
POOL contract delta (+8500 = +10000 premium-in -1000 treasury -500 affiliate)
and the on-chain ERC-20 Transfer logs in the step-5 receipt (7 logs:
agent->pool premium, pool->treasury 1000, pool->affiliate 500, plus
accounting). The affiliate economic receipt is parity-correct; the gas is
chain-level noise, not a settlement amount.

### Step 6 (BREACH) literal deltas: post-6 minus post-5

| Address | post-5 | post-6 | delta | predicted | verdict |
|---------|--------|--------|-------|-----------|---------|
| AGENT_EOA | 188891 | 186891 | -2000 | -10000 premium +8000 refund = -2000 (no gas) | MATCH |
| DEPLOYER (treasury) | 19151753 | 19152753 | +1000 | +1000 (treasury fee, no gas) | MATCH |
| SETTLER_EOA | 495815 | 491173 | -4642 | +500 affiliate MINUS gas (broadcaster) | see note B |
| POOL (contract) | 58500 | 59000 | +500 | +10000 -1000 -500 -8000 = +500 | MATCH |

Note B (SETTLER_EOA, step 6): raw delta -4642 = +500 affiliate fee - 5142
gas. The +500 affiliate receipt is PROVEN by the POOL contract delta
(+500 = +10000 premium-in -1000 treasury -500 affiliate -8000 refund) and
the step-6 receipt (9 logs: agent->pool premium, pool->treasury 1000,
pool->affiliate 500, pool->agent 8000 refund, plus accounting). Parity-correct.

### C6 deployer triple-role SEPARATE assertion (authority + treasury + funder)

The deployer's roles are asserted SEPARATELY, not netted:
- As FUNDER (topUp, step 3b, tx 0x1855d8...): raw outflow -50000 USDC into
  the POOL contract. Confirmed: POOL contract 0 -> 50000 at step 3.
- As TREASURY (fee recipient, steps 5 & 6): raw inflow +1000 per call.
  Confirmed: DEPLOYER +1000 (step5) and +1000 (step6), each in isolation
  with NO gas noise (deployer did not broadcast the settle txs).
- As AUTHORITY: grantRole (step 1), registerEndpoint (step 2), approve+topUp
  (step 3) — all succeeded with status 0x1; gas for these came out of the
  deployer balance between pre-flight (19910942) and pre-5 (19150753).
These three are independently true; no mismatch.

---

## Pool state + endpoint stats (raw reads)

PoolState struct order (IPactPool.sol): (currentBalance, totalDeposits,
totalPremiums, totalRefunds, createdAt).

| Pool field | post-3 | post-5 | post-6 (FINAL) | predicted FINAL | verdict |
|------------|--------|--------|----------------|-----------------|---------|
| currentBalance | 50000 | 58500 | 59000 | 59000 | MATCH |
| totalDeposits | 50000 | 50000 | 50000 | 50000 | MATCH |
| totalPremiums | 0 | 10000 | 20000 | 20000 | MATCH |
| totalRefunds | 0 | 0 | 8000 | 8000 | MATCH |
| createdAt | 1779173162 | 1779173162 | 1779173162 | set@firstTopUp (D2) | MATCH |

Endpoint stats (getEndpoint), FINAL:
| ep field | value | predicted | verdict |
|----------|-------|-----------|---------|
| paused | false | false | MATCH |
| flatPremium | 10000 | 10000 | MATCH |
| slaLatencyMs | 2000 | 2000 | MATCH |
| exposureCapPerHour | 50000 | 50000 | MATCH |
| totalCalls | 2 | 2 | MATCH |
| totalBreaches | 1 | 1 | MATCH |
| totalPremiums | 20000 | 20000 | MATCH |
| totalRefunds | 8000 | 8000 | MATCH |
| feeRecipientCount | 2 | 2 | MATCH |
| feeRecipients[0] | (0, deployer, 1000) | Treasury 1000bps | MATCH |
| feeRecipients[1] | (1, SETTLER_EOA, 500) | Affiliate 500bps | MATCH |

---

## Per-step parity assertion PASS/FAIL vs settle_batch.rs

| Step | Parity assertion | Source anchor | Verdict |
|------|------------------|---------------|---------|
| 1 | settleBatch onlyRole(SETTLER_ROLE); grant succeeds from DEFAULT_ADMIN==deployer | E2 LOCKED; settle_batch.rs:95-97 | PASS |
| 2 | authority->slug->fee-validate->already-registered->write; Treasury substituted; bps sum 1500<3000 | register_endpoint.rs | PASS |
| 3 | topUp authority-gated (D3); cp.current_balance/total_deposits += amount; createdAt lazy (D2) | top_up_coverage_pool.rs; D2/D3 | PASS |
| 4 | approve enables transferFrom; >= premium so premiumInOk=true | settle_batch.rs:295-313 (EVM try/catch) | PASS |
| 5 | premium-in +10000; floor-div fee split 1000/500; pool residual +8500; ep totalCalls=1; status Settled | settle_batch.rs:360-453 | PASS |
| 6 | premium-in; fee split; refund 8000 (capRemaining 50000, no clamp; pool 67000>=8000, not depleted); totalRefunds/totalBreaches; status Settled | settle_batch.rs:380-501 | PASS |
| 7 | replayed callId reverts DuplicateCallId; dedup SET precedes premium-in (agent balance unchanged) | settle_batch.rs:194-196; E4 LOCKED | PASS |

Floor-div fee split: floor(10000*1000/10000)=1000, floor(10000*500/10000)=500,
pool=10000-1500=8500 — bit-identical to settle_batch.rs:428-429 integer math.
Pool-as-residual: POOL contract delta matched the residual exactly both calls.
Clamp/PoolDepleted ordering (WP-05 OUTCOMES seam 4): step 6 refund 8000 within
exposureCap 50000 (no ExposureCapClamped) and pool balance 67000 >= 8000 (no
PoolDepleted) -> status Settled, as predicted. Ordering not adversarially
exercised here (would need a depleted pool / over-cap refund) — those clamp
paths are covered by the 102 ported forge scenario tests (WP-05); this live
e2e proves the happy-path economics + dedup on real USDC.

---

## Findings

NONE. Zero economic discrepancies vs settle_batch.rs across all 7 steps.
Every predicted integer delta matched the raw on-chain value exactly (the
only non-exact raw deltas are SETTLER_EOA's, fully explained by Arc gas being
paid in USDC by the broadcaster — the settlement economic receipt of +500
affiliate per call is independently proven by the POOL contract residual and
the ERC-20 Transfer logs; this is chain-level gas accounting, NOT a
settlement-amount discrepancy). No contract was changed. No parity defect.

---

## Funding budget actual vs planned

| Item | planned | actual |
|------|---------|--------|
| -> SETTLER_EOA | 500000 (0.5 USDC) | 500000 |
| -> AGENT_EOA | 200000 (0.2 USDC) | 200000 |
| topUp into pool | 50000 (0.05 USDC) | 50000 |
| total deployer USDC consumed | ~1.0 USDC | 19910942 -> 19152753 = 758189 (~0.76 USDC) used, mostly the 700000 transfers + auth-tx gas; deployer net also received +2000 treasury fees |

Well within budget; deployer retains ~19.15 USDC.

---

## C1 post-Gate-B key cleanup (to be executed AFTER captain GATE B verdict)

Per C1, after the captain GATE B verdict the crew will:
1. Delete the E2E_SETTLER_PRIVATE_KEY and E2E_AGENT_PRIVATE_KEY lines from
   packages/program-evm/protocol-evm-v1/.env (addresses may remain as
   non-sensitive run documentation).
2. Prove via `git status` + `git diff --staged` that no key is staged
   anywhere and .env remains untracked/ignored.
This is deferred to the cleanup turn so the keys remain available if the
captain requests any re-verification read. Status of pre-cleanup check
(performed now, before any commit): .env is gitignored
(git check-ignore PASS) and ABSENT from `git status` — no key is or can be
staged. NO commit has been made by this crew yet.

---

STATUS: GATE B EVIDENCE COMPLETE. ALL 7 STEPS PASS. ZERO FINDINGS.
Awaiting 07b-CAPTAIN-GATE-B-VERDICT.md. No push / no PR comment until then.

---

## DONE-STATE — Gate B APPROVED (closeout)

GATE B VERDICT: **APPROVED** (07b-CAPTAIN-GATE-B-VERDICT.md). The captain
independently re-verified on-chain — ERC-20 Transfer logs, CallSettled
events, final endpoint+pool state, and a dedup re-sim — and confirmed the
economic settlement flow is bit-faithful to settle_batch.rs with ZERO
discrepancies.

WP-EVM-07b PASSES. The Arc Testnet deployment is now proven end-to-end:
deploy + arcscan-verify (WP-07) + logic/guard differential-parity
(07-LIVE-VERIFICATION) + real-USDC economic settlement (this WP).

### The 2 settle transaction hashes (chain 5042002)

- PASS:   0x5de62ff55be0bf55004eff5a8008fa7aec6c1c98e34c9738dac0021fa20c4461 (status 0x1, block 42968139)
- BREACH: 0x6014f63d9f2e4e34e0f3d6c3a785a9ff93446dc8d36ec1c1d21689efdd57b67f (status 0x1, block 42968231)
- Dedup negative: replay of PASS callId reverts DuplicateCallId (0x4999df69)

### Final on-chain state (verified)

- getEndpoint: paused=false, totalCalls=2, totalBreaches=1,
  totalPremiums=20000, totalRefunds=8000, currentPeriodRefunds=8000
- pool.balanceOf: currentBalance=59000, totalDeposits=50000,
  totalPremiums=20000, totalRefunds=8000
  (math closes: 50000 + 20000 - 2*(1000+500) - 8000 = 59000)

### C1 KEY CLEANUP — COMPLETED

The throwaway test wallets' private keys (E2E_SETTLER_PRIVATE_KEY,
E2E_AGENT_PRIVATE_KEY) were DELETED from the gitignored
packages/program-evm/protocol-evm-v1/.env after the captain's on-chain
re-verification (which used only read calls — keys no longer needed). Proven:
- grep for the E2E private-key var names in .env returns 0
- E2E_SETTLER_ADDRESS / E2E_AGENT_ADDRESS retained (non-sensitive)
- .env still gitignored (git check-ignore PASS), absent from git status
- nothing sensitive staged; no key ever appeared in any commit/report/output
The throwaway wallets hold only residual Arc Testnet USDC; no recovery needed.

WP-EVM-07b CLOSED. No further crew.
