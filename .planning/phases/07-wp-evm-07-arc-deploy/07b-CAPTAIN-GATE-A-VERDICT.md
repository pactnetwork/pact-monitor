# WP-EVM-07b — Captain GATE A Verdict: APPROVED WITH CONDITIONS

Independently verified the plan's mechanics + economics against the locked
contracts and settle_batch.rs — not a rubber-stamp.

## Verified correct (no issue)

- Fee-split arithmetic: premium 10000, Treasury 1000bps->1000, Affiliate
  500bps->500, pool residual 8500. Floor-div matches settle_batch.rs fee
  formula; pool = premium - total_fees (pool-as-residual). Clean, no rounding
  ambiguity. OK.
- topUp mechanic: VERIFIED PactPool.sol:49-52 — `if (msg.sender !=
  registry.authority()) revert UnauthorizedAuthority; if(!isRegistered)
  EndpointNotFound; _usdc.safeTransferFrom(msg.sender,this,amount)`. The plan
  is correct: DEPLOYER(=authority) calls topUp AFTER registerEndpoint, with a
  prior USDC approve to POOL. Matches the live probe (AUTH topUp on
  unregistered slug -> EndpointNotFound, i.e. it passed the auth check).
- SETTLER_ROLE grant target: correct — PactSettler.settleBatch is
  onlyRole(SETTLER_ROLE) on PactSettler; DEFAULT_ADMIN_ROLE on PactSettler ==
  registry.authority() == DEPLOYER (verified Gate B). DEPLOYER grants
  SETTLER_ROLE on the PactSettler contract to SETTLER_EOA.
- Refund/exposure-cap/PoolDepleted ordering matches WP-05 OUTCOMES seam 4
  (pool-balance check then status overwrite). RecipientCoverageMismatch /
  feeRecipientCountHint=2 reasoning correct (settle_batch.rs:213-215).
- Affiliate destination (SETTLER_EOA): non-zero, != treasury, not duplicate —
  valid per the narrowed §4#7 affiliate guard.

## CONDITIONS (must honor; C1/C2 are correctness/safety-critical)

### C1 — KEY-LEAK HAZARD (HIGH). `cast wallet new` prints the private key to
stdout; this crew is a subagent whose tool output is captured to its
transcript/output file and may hit logs. The throwaway private keys MUST NEVER
appear in any tool result, report file, commit, or agent transcript. Generate
each wallet with a SINGLE shell command that parses `cast wallet new` inside
the command and appends `E2E_*_PRIVATE_KEY=...` directly into the gitignored
.env, emitting ONLY the address to stdout (never the key). Run
`git check-ignore -v packages/program-evm/protocol-evm-v1/.env` and confirm it
is ignored BEFORE writing any key; if not ignored, STOP-AND-ASK. Post-Gate-B:
delete the two E2E_*_PRIVATE_KEY lines and prove via `git status` +
`git diff --staged` that no key is staged anywhere.

### C2 — TIMESTAMP ROBUSTNESS. VERIFIED PactSettler.sol:81 `if (ev.timestamp
> uint64(block.timestamp)) revert InvalidTimestamp()` (exact parity
settle_batch.rs:158). Wall-clock `$(date +%s)` can exceed a lagging block
timestamp -> InvalidTimestamp false-revert that burns a callId + gas. The
SettlementEvent `timestamp` MUST be derived from chain time —
`cast block latest --field timestamp` (or equivalent) MINUS a small safety
margin (e.g. 30s) — NOT wall clock. Pin this in steps 5/6.

### C3 — ORDERING (verified, enforce). registerEndpoint (step 2) MUST precede
topUp (step 3); `balanceOf`/topUp on an unregistered slug revert
EndpointNotFound (PactPool.sol:50,72). Only read pool.balanceOf AFTER step 2.

### C4 — CALLID HYGIENE. Dedup SET precedes premium-in (E4 LOCKED;
settle_batch.rs:194 / PactSettler dedup-before-premium). A callId consumed by
ANY attempt (even a reverted/DelegateFailed one) is permanently burned. Any
operational retry of a settle step MUST use a fresh, never-submitted callId.
Never reuse.

### C5 — UNCHANGED HARD CONSTRAINTS + ESCALATION. No contract change (only
.planning docs + gitignored .env; no file created under packages/program-evm/
except the gitignored .env). The crew posts the section-8 READY-TO-BROADCAST
note then HALTS; broadcast is released ONLY after BOTH (a) this verdict and
(b) a separate explicit USER go for fund-moving txs (captain is collecting it).
ANY economic delta vs settle_batch.rs at execution = CRITICAL parity finding:
HALT, capture tx/receipt, escalate via 07b-REPORT-gateB.md, NEVER edit a locked
contract. File-scoped conventional commits; NO push / NO PR comment until the
captain GATE B verdict.

### C6 — ASSERT RAW, REPORT HONEST. Gate B must record ACTUAL raw before/after
USDC balances and the literal integer deltas for EVERY address (agent,
treasuryVault==deployer, settler==affiliate, POOL contract) plus pool state +
ep stats, and flag ANY deviation from the plan's predicted numbers as a
finding — do not net-interpret a mismatch away. The deployer's triple role
(authority+treasury+funder) is the trickiest: assert the raw treasury-fee
receipt (+1000 per call) and the topUp outflow (-50000) SEPARATELY, not only
the net.

## Proceed

Execute steps 1-7 as written with C1-C6 folded in. The crew does NOT generate
wallets / fund / broadcast until: this verdict (done) AND the user's explicit
fund-moving GO (captain is obtaining it now). Then it posts the
READY-TO-BROADCAST note and HALTS for the captain's release. GATE B: full
evidence per section 5 + C6, WAIT for 07b-CAPTAIN-GATE-B-VERDICT.md, no push
until then.
