# WP-EVM-07 — Captain GATE A Verdict: APPROVED WITH CONDITIONS

Independently verified against the LOCKED contracts and Solana parity source —
not a rubber-stamp.

## Verified EXACT (no issue)

- PactRegistry ctor signature == plan §4 T1.2a: `(address authority_, address
  usdc_, address treasuryVault_, uint16 maxTotalFeeBps_,
  IPactRegistry.FeeRecipient[8] memory defaultRecipients_, uint8
  defaultCount_)` — PactRegistry.sol:56-69. MATCH.
- PactPool ctor `(address usdc_, address registry_)` — PactPool.sol:29. MATCH.
- PactSettler ctor `(address usdc_, address registry_, address pool_)` —
  PactSettler.sol:46. MATCH.
- maxTotalFeeBps = `ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS` = 3_000 (ArcConfig.sol:31)
  == Solana constants.rs:23 `DEFAULT_MAX_TOTAL_FEE_BPS: u16 = 3_000`. EXACT
  PARITY.
- Empty default template (defaultRecipients_ all-zero, defaultCount_ = 0):
  PARITY-VALID. Confirmed by initialize_protocol_config.rs:138-156 ("count == 0
  is allowed — operators who want every endpoint to declare its own recipients
  can deploy with empty defaults") AND PactRegistry.sol:64
  `FeeValidation.validateDefaultTemplate(...)` whose doc pins
  initialize_protocol_config.rs:84-156 semantics ("no substitution, count == 0
  allowed").
- SETTLER_ROLE admin path: PactRegistry.sol:68 `_grantRole(DEFAULT_ADMIN_ROLE,
  authority_)`; PactPool.sol:35 `_grantRole(DEFAULT_ADMIN_ROLE,
  registry.authority())`. The authority holds admin on BOTH and can grant
  SETTLER_ROLE to the settler. Correct — SUBJECT TO C1.
- USDC-decimals guard (handoff §(c)), check:abi T0-c/T6 (handoff §(c)),
  addresses.ts DEPLOYMENTS bake + resolveDeployment overlay (handoff §(c)),
  no-contract-change (only script/Deploy.s.sol authored — the WP-EVM-01
  scaffold itself scopes the real deploy script to WP-EVM-07): all correct.

## CONDITIONS (must be honored; C1/C2 are pre-broadcast STOP-AND-ASK)

### C1 — DEFECT: authority_ MUST equal the deployer EOA (remove the optionality)

Plan §3 line 64-65 and §4 T1.2a allow "designated authority if Rick/Alan
supply a separate address". This is WRONG for WP-07: the post-deploy
SETTLER_ROLE grants (§4 T1.3) are issued BY the deployer and only succeed if
the deployer holds DEFAULT_ADMIN_ROLE, i.e. deployer == registry.authority().
If a separate authority is baked, the script's grantRole calls revert and the
deploy is broken. FIX: for WP-07, `authority_` := the deployer EOA, full stop.
A separate/rotated authority is OUT OF SCOPE for WP-07 (it is the later
mainnet authority-rotation concern, deferred per the handoff) and would be a
post-deploy grant/transfer step, not a constructor arg. Delete the
separate-authority branch from the deploy script.

### C2 — IMMUTABILITY RISK: one consolidated deploy-parameter ratification before broadcast

`treasuryVault` is set once at PactRegistry.sol:70 with NO setter (grep
confirmed: only assignment is the ctor) — it is PERMANENT for the life of the
deployment. `maxTotalFeeBps` likewise has no setter. Before T3 broadcast the
crew MUST obtain ONE consolidated explicit confirmation from Rick/Alan
(STOP-AND-ASK, single clean question, not piecemeal):

1. The deployer EOA address (= authority per C1).
2. The real `TREASURY_VAULT_ADDRESS` — a deliberate, intended address. NEVER
   `address(0)`, never an accidental/throwaway EOA. It is immutable post-deploy;
   a wrong value means full redeploy.
3. Explicit ratification that the default fee template is EMPTY
   (`defaultCount_ = 0`): every endpoint registered on this deployment must
   then declare its OWN fee recipients (feeRecipientsPresent = true); there is
   NO protocol-default treasury cut. This is parity-valid and the correct
   low-risk testnet choice, but it is baked at deploy and must be a conscious
   ratification, not a silent default.

Do NOT broadcast until all three are confirmed in writing.

### C3 — Scope tightening: read-only smoke is the required Gate B evidence

§3 mentions a write `PactPool.topUp` smoke; §4 T7 is read-only. Resolve in
favor of: T7 read-only smoke calls (authority/usdc/registry/2x hasRole) are
REQUIRED and SUFFICIENT for Gate B. A write top-up smoke is OPTIONAL, additive
evidence only, minimal amount if done. USDC: ~0.5 testnet USDC covers the 3
deploys + 2 grants; keep 5 USDC as the recommended ask (faucet is generous, no
downside to headroom).

### C4 — Verification realism (arcscan is a documented residual-unknown)

The deploy is the core deliverable and does NOT block on arcscan verification
succeeding (design §4.8.4 / foundry.toml both flag the arcscan flow as
unconfirmed). Gate B MUST record the ACTUAL per-contract outcome honestly:
verified | flattened-source-uploaded-via-web-UI | blocked-pending-arcscan-
support, with the attempts logged. A documented verification-blocked state
(with fallback attempts recorded) is an ACCEPTABLE Gate B outcome. A false
"verified" claim is not — only claim verified if the arcscan code tab shows
verified source.

### C5 — Process (unchanged, enforced)

File-scoped conventional commits per §8; NO push / NO PR #204 comment until
Gate B captain approval; tree stays clean (only expected untracked:
.claude/pr-reviews/, .planning/phases/07-*); NEVER run a pact skill installer
/ pact --help / skill bootstrap in the live checkout; contracts are NOT edited
(only script/Deploy.s.sol authored). T0-c check:abi is the FIRST gating action
— any FAIL is a hard STOP-AND-ASK (unauthorized contract drift is escalated,
NEVER "fixed" by editing a contract).

## Proceed

Execute §4 T0 -> T8 with C1 folded into the script (authority_ = deployer),
C2 as a pre-broadcast STOP-AND-ASK consolidated ratification, C3/C4/C5
honored. Non-chain prep (T0-a/c/d pre-flight, T1 author deploy script + commit,
T2 dry-run) may proceed now. T3 broadcast and everything after REQUIRES: this
verdict (done) + DEPLOYER_PRIVATE_KEY + funded deployer EOA + the C2
three-part ratification. GATE B: write 07-REPORT-gateB.md with the §4 T8
evidence set, WAIT, NO push / NO PR comment until the captain Gate B verdict
file.
