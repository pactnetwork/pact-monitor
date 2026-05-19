# WP-EVM-07b — Captain GATE B Verdict: APPROVED (economic e2e PROVEN)

Independently verified against the live chain (receipts, ERC-20 Transfer
logs, CallSettled events, final state) + git/key safety — NOT a rubber-stamp.
The crew report was accurate.

## Independently confirmed on-chain (captain ran cast directly)

PASS tx 0x5de62ff5...c4461 — status 0x1, block 42968139. USDC Transfers:
- agent 0x37a8..ec7d -> POOL 0xa613..afde : 10000  (premium-in)
- POOL -> treasury 0x777d..b859 : 1000  (floor(10000*1000/10000))
- POOL -> affiliate 0xfc56..22c6 : 500  (floor(10000*500/10000))
- CallSettled premium=0x2710(10000) refund=0x0. Pool residual 8500.

BREACH tx 0x6014f63d...b67f — status 0x1, block 42968231. USDC Transfers:
- agent -> POOL : 10000  (premium-in)
- POOL -> treasury : 1000 ; POOL -> affiliate : 500
- POOL -> agent 0x37a8..ec7d : 8000  (refund)
- CallSettled premium=0x2710(10000) refund=0x1f40(8000).

Final on-chain state (independent reads):
- getEndpoint: paused=false, totalCalls=2, totalBreaches=1,
  totalPremiums=20000, totalRefunds=8000, currentPeriodRefunds=8000,
  feeRecipients=[Treasury 0x777d..b859 @1000bps, Affiliate 0xFc56..22c6
  @500bps]. Exactly as planned.
- pool.balanceOf: currentBalance=59000, totalDeposits=50000,
  totalPremiums=20000, totalRefunds=8000. Math closes exactly:
  50000 + 20000 - 2*(1000+500) - 8000 = 59000.
- Dedup re-sim (captain eth_call replay of PASS callId): reverts 0x4999df69
  DuplicateCallId. Dedup live, SET precedes premium-in (E4 LOCKED).

Every figure is exact floor-div parity, pool-as-residual, refund, dedup,
exposure-cap (8000 < cap 50000, no clamp; status Settled) — bit-faithful to
settle_batch.rs. ZERO discrepancies. This is the economic settlement flow
PROVEN working with real USDC on the live Arc Testnet deployment.

## Conditions C1-C6: honored

- C1: no private key in commit ea25d7e or the tree; .env gitignored
  (verified git check-ignore); keys .env-only. Post-Gate-B key DELETION still
  pending — assigned in closeout below.
- C2: settle timestamps chain-derived (-30s), not wall clock — no
  InvalidTimestamp false-revert occurred.
- C3: register before topUp; balanceOf read post-register only.
- C4: distinct callIds (..01 / ..02); replay correctly burned.
- C5: zero contract change (git diff 07a79be..HEAD -- src/ empty); commit
  file-scoped docs; NOT pushed. No parity discrepancy => no escalation needed.
- C6: raw deltas asserted; deployer triple role (topUp -50000 / treasury
  +1000/call / authority) separated; SETTLER_EOA delta = +500 affiliate minus
  Arc USDC gas (broadcaster) — correctly explained, parity-neutral.

## Verdict

WP-EVM-07b PASSES. The Arc Testnet deployment is now proven end-to-end:
deploy + arcscan-verify (WP-07) + logic/guard differential-parity
(07-LIVE-VERIFICATION) + real-USDC economic settlement (this). The contracts
work correctly and parity-faithfully on-chain.

## Closeout (in order, then STOP)

1. C1 KEY CLEANUP (security, do FIRST): delete the E2E_SETTLER_PRIVATE_KEY and
   E2E_AGENT_PRIVATE_KEY lines from packages/program-evm/protocol-evm-v1/.env
   (E2E_*_ADDRESS lines may remain — non-sensitive). Prove: `grep -c
   PRIVATE_KEY .env` excludes the E2E keys; `git status` + `git diff --staged`
   show nothing sensitive staged; .env still gitignored. Captain
   re-verification used only on-chain reads — the throwaway keys are no longer
   needed.
2. Append a DONE-STATE block to 07b-REPORT-gateB.md (Gate B APPROVED; the 2 tx
   hashes; final state; C1 cleanup done).
3. Commit file-scoped (docs(phase-07b): Gate B verdict + DONE-STATE + C1 key
   cleanup) — the .env is gitignored so the deletion is not a tracked diff;
   note the cleanup in the commit body.
4. PUSH origin feat/arc-protocol-v1 (carries ea25d7e + the closeout commit).
5. PR #204 comment — short addendum: "WP-EVM-07b economic e2e PASSED" — the 2
   settle tx hashes, the proven flow (premium-in / Treasury+Affiliate
   floor-div split / pool residual / SLA-breach refund / dedup), final
   endpoint+pool state, zero parity findings; the deployment is now proven
   end-to-end with real USDC.
6. Extend docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md with a
   short "WP-EVM-07b ECONOMIC E2E PROVEN" note (tx hashes + result + that the
   throwaway test wallets/keys were cleaned). File-scoped; include in push.
7. Append done-state to 07b-REPORT-gateB.md. Then STOP — no further crew.
   Captain updates project memory + closes out.
