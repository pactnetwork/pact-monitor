# WP-EVM-07b — Live Economic E2E Validation — CREW BRIEF

Goal: PROVE the economic settlement flow end-to-end on the LIVE deployed Arc
Testnet contracts with real USDC movement. This is the test simulation cannot
do. NO contract change (contracts LOCKED; only test scripts/docs). Real
broadcasts, TESTNET ONLY.

Working dir: /Users/q3labsadmin/Q3/Solder/pact-network. Branch
feat/arc-protocol-v1.

## STEP 0 — read first
- .planning/phases/07-wp-evm-07-arc-deploy/07-LIVE-VERIFICATION.md (what is
  already proven by simulation + the empty-default-template operational
  constraint: every endpoint MUST be registered with explicit recipients incl.
  exactly one Treasury entry).
- .planning/phases/07-wp-evm-07-arc-deploy/07-C2-RATIFICATION.md (deploy params).
- docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md (parity rulings;
  settle_batch behavior; WP-04/05 OUTCOMES — the settle economics you must
  assert against).
- Solana parity source for the economics you assert:
  packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs
  (premium-in, fee split Treasury/Affiliate, pool residual, refund, exposure
  cap, dedup). Your on-chain assertions MUST match this behavior.

## Live contracts (chain 5042002, RPC https://rpc.testnet.arc.network)
PactRegistry 0x056BAC33546b5b51B8CF6f332379651f715B889C ·
PactPool 0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE ·
PactSettler 0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f ·
USDC 0x3600000000000000000000000000000000000000 (6-dec) ·
authority/deployer EOA 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859.

## Wallets
- DEPLOYER/AUTHORITY/FUNDER: DEPLOYER_PRIVATE_KEY in
  packages/program-evm/protocol-evm-v1/.env (already present). It is the
  protocol authority AND the only faucet-funded EOA. NEVER echo/print/commit
  the key; names-only .env inspection.
- Generate TWO throwaway keys (cast wallet new): SETTLER_EOA, AGENT_EOA.
  Write them ONLY into the gitignored .env (e.g. E2E_SETTLER_PRIVATE_KEY /
  E2E_AGENT_PRIVATE_KEY) — never elsewhere, never committed, never echoed.
- Fund both from the deployer EOA: transfer the MINIMUM Arc gas+USDC needed
  (Arc gas = USDC). Compute a tight budget in the Gate A plan (gas for the
  grant/register/topUp/approve/2x settle txs + the premium the agent must
  hold + a small margin). State exact numbers.

## E2E sequence (every step a real tx — itemize in the Gate A plan with exact calldata, expected effect, and the Solana-parity assertion)
1. authority.grantRole(SETTLER_ROLE, SETTLER_EOA) on PactSettler so SETTLER_EOA
   can call settleBatch. (PactSettler already holds SETTLER_ROLE on
   registry+pool from deploy — re-confirm by read.)
2. authority.registerEndpoint(slug, flatPremium, percentBps, slaLatencyMs,
   imputedCost, exposureCapPerHour, feeRecipientsPresent=true, count,
   recipients) with EXPLICIT recipients: exactly one Treasury entry (kind 0,
   bps>0) and optionally one Affiliate (kind 1) — pick values so the split is
   arithmetically checkable (e.g. premium 10000, Treasury 1000 bps, Affiliate
   500 bps -> assertable Treasury/Affiliate/pool amounts). Determine exact
   slug bytes16. Verify isRegistered + getEndpoint after.
3. Fund the pool for the endpoint: determine topUp's exact access control
   (who may call topUp — read the contract) and the correct funding path
   (USDC approve -> topUp). Top up enough to cover the breach refund in step 6.
4. AGENT: USDC.approve(PactSettler, premium) so the settler can pull premium.
5. SETTLER_EOA.settleBatch([PASS event: breach=false, refund=0]) — assert:
   agent USDC -= premium; treasuryVault USDC += premium*treasuryBps/10000
   (floor); affiliate += premium*affBps/10000; pool currentBalance += residual;
   endpoint totalCalls/totalPremiums updated; CallSettled event fields. ALL
   arithmetic must match settle_batch.rs (floor div, pool = residual).
6. SETTLER_EOA.settleBatch([BREACH event: breach=true, refund>0]) — assert the
   refund path per settle_batch.rs (refund to agent, pool debited,
   exposure-cap clamp / PoolDepleted ordering as the WP-05 OUTCOMES locked
   it), balances, totalBreaches/totalRefunds, event.
7. Negative on-chain: re-submit the step-5 callId -> expect DuplicateCallId
   revert (dedup live). Optional: batch>50 -> BatchTooLarge.
8. Capture every tx hash, receipt status, decoded event, and before/after
   USDC balances (agent, treasuryVault, affiliate, pool) + getEndpoint stats.

## Methodology — captain gate cadence (same as WP-07)
GATE A: author the full test plan to
.planning/phases/07-wp-evm-07-arc-deploy/07b-REPORT-gateA.md — itemized tx
sequence, exact amounts/calldata, the parity assertion for each, the funding
budget, the throwaway-wallet handling, rollback/cleanup, and every exact
cast/forge command. Then STOP. Do NOT generate wallets, fund, or broadcast
anything until the captain writes 07b-CAPTAIN-GATE-A-VERDICT.md AND (the
captain will separately confirm the user's go for fund-moving broadcasts).

After Gate A approval you will be re-engaged; even then, STOP-AND-ASK once more
immediately BEFORE the first broadcast (post a one-line readiness note in the
report file) — the captain releases the broadcast.

GATE B: after execution, write 07b-REPORT-gateB.md with every tx hash, the
on-chain before/after balances, decoded events, the per-step parity assertion
PASS/FAIL, and an HONEST result (a real economic discrepancy vs settle_batch.rs
is a CRITICAL finding — HALT, do NOT touch contract code, escalate via the
report file; the contracts are LOCKED, any discrepancy is a parity defect to
report, not fix). Then STOP for the captain GATE B verdict.

## Hard constraints
NO contract change (only test scripts under script/ or a scratch dir + .planning
docs). Private keys: never echo, never commit, .env is gitignored — verify
before any commit that no key leaked. File-scoped conventional commits. NO push
/ NO PR comment until captain Gate B approval. Never run a pact skill installer
/ pact --help in the live checkout. Keep tree clean. If anything needs a
contract edit or a parity ambiguity surfaces -> STOP-AND-ASK via the report
file, never guess. cockpit relay misroutes + mangles special chars — files in
.planning/phases/07-wp-evm-07-arc-deploy/ are the source of truth.

## Start
Do STEP 0, then author 07b-REPORT-gateA.md, then STOP. Generate NOTHING, fund
NOTHING, broadcast NOTHING. Report a short ASCII status when the plan is
written.
