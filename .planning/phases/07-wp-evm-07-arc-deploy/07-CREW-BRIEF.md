# WP-EVM-07 — Arc Testnet Deploy + arcscan Verify — CREW BRIEF

You are the WP-EVM-07 deploy crew for project pact-network. Branch
feat/arc-protocol-v1 at HEAD 07a79be. The repo dir is named pact-network but
the GitHub repo is pactnetwork/pact-monitor (origin solder-build/pact-monitor),
PR #204. Work on the SAME branch feat/arc-protocol-v1.

## STEP 0 — READ THE SOURCE OF TRUTH BEFORE ANYTHING ELSE

Read these in full, in order, before writing any plan:

1. docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md — END TO END.
   The section "PARITY PORT COMPLETE — WP-07 deploy prerequisites
   (2026-05-19)" at line 592, parts (a)-(d), is the canonical technical
   source of truth for this WP. Everything above it is settled law, NOT
   reopened.
2. docs/superpowers/specs/2026-05-15-arc-parity-port-design.md — USE THE
   CORRECTED spec (the "WP-EVM-06 Corrections" appendix). Never the
   pre-correction text.
3. docs/superpowers/specs/2026-05-18-arc-parity-matrix.md — the per-variant
   parity proof; reference only, do not modify.
4. packages/protocol-evm-v1-client/src/addresses.ts and
   packages/protocol-evm-v1-client/scripts/gen-abi.mjs +
   scripts/check-abi-drift.mjs and test/UsdcDecimals.t.sol (the existing
   USDC-decimals guard shape you will reuse in the deploy script).

## SCOPE — DEPLOY + VERIFY ONLY

Concretely (per handoff section (c)):

- Deploy PactRegistry, PactPool, PactSettler to Arc Testnet:
  chain id 5042002, RPC https://rpc.testnet.arc.network,
  explorer https://testnet.arcscan.app,
  testnet USDC at 0x3600000000000000000000000000000000000000
  (6-decimal ERC-20; native gas is USDC on Arc).
- Verify all three contracts on arcscan (https://testnet.arcscan.app).
- Fill packages/protocol-evm-v1-client/src/addresses.ts: the
  registry/pool/settler placeholders are null today. Populate via the env
  overlay (resolveDeployment(chainId, env) reading PACT_EVM_REGISTRY /
  PACT_EVM_POOL / PACT_EVM_SETTLER, checksum-validated) and/or bake final
  addresses into DEPLOYMENTS. Mirror the existing typed-registry shape; do
  not invent a new mechanism.
- Wire the live IERC20(USDC).decimals()==6 assertion (same require-shaped
  guard as test/UsdcDecimals.t.sol) into the deploy script so a
  wrong-decimals USDC fails the deploy loudly.
- Run pnpm --filter @pact-network/protocol-evm-v1-client check:abi BEFORE
  and AFTER deploy to prove the deployed bytecode ABI still matches the
  committed client ABI (the D-A drift guard).

## HARD CONSTRAINTS — DO NOT VIOLATE

- NO contract change. Contracts are LOCKED WP-02..05; WP-06 added zero
  contract behavior. Any contract edit (even one line of .sol logic) is a
  NEW captain-gated cycle, NOT WP-07. If you believe a contract must change
  to deploy, STOP-AND-ASK the captain via the report file — do not edit.
- All WP-02/03 rulings 1-8, WP-04 OUTCOMES, WP-05 OUTCOMES (P1/P3 final
  forms, the 2157b75 alias, the 4 filled seams) remain in force and are
  NOT reopened.
- pnpm and forge only, never npm. No emojis anywhere. File-scoped
  conventional commits. NO push and NO PR comment until the captain
  approves the relevant gate.
- Never run a pact skill installer, pact --help, or any skill bootstrap
  inside this live checkout (a prior contamination incident wrote into
  CLAUDE.md and .claude/skills; quarantine at
  /Users/q3labsadmin/Q3/Solder/_quarantine). Keep the working tree clean —
  the only expected untracked entry is .claude/pr-reviews/.

## OPERATIONAL BLOCKER — STATE IT, DO NOT WORK AROUND IT

The on-chain deploy requires an Arc Testnet deployer key + faucet USDC
(faucet at https://faucet.circle.com dispenses testnet USDC, no account).
This is provided by Rick/Alan/the deployer — it is NOT yours to generate.

In your Gate A plan you MUST:
- Identify exactly which env vars / secret / keystore the deploy script
  will expect (name them) and the minimum faucet USDC needed for gas +
  any pool seeding.
- State explicitly that on-chain execution is BLOCKED until that key +
  faucet USDC is supplied, and that you will STOP-AND-ASK at the
  deploy-execution boundary rather than attempt any on-chain action
  without it.
Do NOT generate a throwaway key and deploy with it. Do NOT proceed past
plan + non-chain prep without the captain verdict AND the provided key.

## METHODOLOGY — CAPTAIN GATE CADENCE (same as WP-02..06)

GATE A (plan review) — DO THIS FIRST, THEN WAIT:
- Author the full WP-EVM-07 deploy plan: task breakdown (deploy script,
  USDC-decimals guard wiring, env-overlay addresses.ts fill, arcscan
  verify, check:abi before/after, smoke read-call against the live
  contracts), dependency order, the named deployer-key/env requirement,
  rollback/redeploy story, and the exact verification commands.
- Write it to
  .planning/phases/07-wp-evm-07-arc-deploy/07-REPORT-gateA.md.
- Then STOP and WAIT. Do NOT execute the deploy, do NOT run any on-chain
  transaction, do NOT push, do NOT comment on PR #204 until the captain
  writes 07-CAPTAIN-GATE-A-VERDICT.md in that same dir approving it.

GATE B (final) — after captain Gate A approval AND key provided + deploy +
verify done:
- Write 07-REPORT-gateB.md with: deployed addresses, arcscan verification
  links, addresses.ts diff, check:abi PASS evidence before+after, the
  USDC-decimals guard firing proof, and the smoke-call result. WAIT for
  07-CAPTAIN-GATE-B-VERDICT.md before push / PR #204 comment / closeout.

COMMUNICATION: the cockpit relay misroutes crew->captain into sibling
panes AND shell-mangles < > backtick $() in both directions. FILES in
.planning/phases/07-wp-evm-07-arc-deploy/ are the only source of truth.
Any cockpit reply you receive will be a SHORT ASCII pointer to a file —
read the file. Send only short ASCII pointers back.

## START NOW

Do STEP 0 (read), then author 07-REPORT-gateA.md, then STOP and wait for
07-CAPTAIN-GATE-A-VERDICT.md. Do not begin execution.
