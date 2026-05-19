# WP-EVM-07b — Live Economic E2E — GATE A Plan

Date: 2026-05-19
Author: WP-EVM-07b crew
Status: AWAITING 07b-CAPTAIN-GATE-A-VERDICT.md

---

## 0. Preamble — what this plan asserts

This plan covers a REAL broadcast, TESTNET ONLY, against the LOCKED and
arcscan-verified deployed contracts:

  PactRegistry  0x056BAC33546b5b51B8CF6f332379651f715B889C
  PactPool      0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE
  PactSettler   0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f
  USDC          0x3600000000000000000000000000000000000000 (6-dec)
  Authority/Treasury/Deployer: 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859

No contract is changed. No key is ever echoed, printed, or committed.
All parity assertions derive from settle_batch.rs as the authoritative source.

---

## 1. Chosen economic parameters (arithmetically checkable)

### Endpoint registration

  slug (bytes16 ASCII):  "e2e-test-slug-01"  (16 bytes, all printable ASCII)
  slug hex:              0x65326574657374736c75672d3031  -- verify with:
                         cast --from-utf8 "e2e-test-slug-01"
                         (must be 16 bytes; pad right with 0x00 if needed)
  NOTE: exact hex computed at execution time via cast; included here for
  planning reference. slug must be exactly bytes16 (32 hex chars).

  flatPremium:           10000   (USDC micro-units = 0.010000 USDC; > MIN_PREMIUM=100)
  percentBps:            0       (not used by settleBatch; field stored only)
  slaLatencyMs:          2000    (2 seconds)
  imputedCost:           10000   (informational; same as premium for simplicity)
  exposureCapPerHour:    50000   (5x the premium; enough headroom for step 6 refund)

  feeRecipientsPresent:  true
  feeRecipientCount:     2
  feeRecipients[0]:      kind=Treasury (0), destination=DEPLOYER_EOA (== treasuryVault),
                         bps=1000   (10%)
  feeRecipients[1]:      kind=Affiliate (1), destination=SETTLER_EOA,
                         bps=500    (5%)
  -- total fee bps = 1500; well under maxTotalFeeBps=3000; no FeeBpsExceedsCap

### Fee-split arithmetic for premium=10000 (all floor division)

  treasury_fee  = floor(10000 * 1000 / 10000) = floor(1.0000) = 1000
  affiliate_fee = floor(10000 *  500 / 10000) = floor(0.5000) =  500
  total_fee     = 1500
  pool_residual = 10000 - 1500 = 8500

Parity anchor: settle_batch.rs:428-429
  fee_amount = (premium_lamports as u128 * bps / 10_000u128) as u64
  (integer floor division; same as EVM uint256 / 10_000 truncation)

### Step-5 PASS settlement (call 1)

  callId:  0x00000000000000000000000000000001  (bytes16; unique)
  breach:  false
  refund:  0
  premium: 10000
  latencyMs: 500
  timestamp: now (at broadcast time, <= block.timestamp)
  feeRecipientCountHint: 2

Expected deltas after step 5:
  agent USDC:             -10000
  pool USDC (contract):   +10000 (premium-in) then -1000 (treasury) -500 (affiliate)
                           net pool USDC = +8500  (= pool residual)
  treasuryVault USDC:     +1000
  SETTLER_EOA USDC:       +500   (affiliate destination)
  pool.currentBalance:    topUp_amount + 8500
  pool.totalPremiums:     10000
  ep.totalCalls:          1
  ep.totalPremiums:       10000
  ep.totalBreaches:       0

### Step-6 BREACH settlement (call 2)

  callId:  0x00000000000000000000000000000002  (bytes16; unique)
  breach:  true
  refund:  8000    (< pool residual of 8500; within exposureCap; refund must succeed)
  premium: 10000
  latencyMs: 3000  (> slaLatencyMs=2000; SLA breach)
  timestamp: now
  feeRecipientCountHint: 2

Expected fee split: same as step 5 (same premium, same recipients)
  treasury_fee  = 1000
  affiliate_fee =  500
  pool_residual = 8500  (on top of whatever remained from step 5)

After fee fan-out, pool.currentBalance for the breach step:
  (post-step5 balance) + 8500 = (topUp_amount + 8500) + 8500

Refund path (settle_batch.rs:456-501):
  payableRefund = 8000 (after recordCallAndCapAccrual; within exposureCap=50000)
  pool.currentBalance at refund check >= 8000 (given topUp_amount >= 8000; see budget)
  => NOT PoolDepleted => refund transfer executes
  actualRefund = 8000

Expected deltas after step 6:
  agent USDC:             -10000 + 8000 = net -2000 from this call
  pool USDC (contract):   +8500 (residual) - 8000 (refund) = +500 net
  treasuryVault USDC:     +1000
  SETTLER_EOA USDC:       +500
  ep.totalCalls:          2
  ep.totalBreaches:       1
  ep.totalRefunds:        8000
  pool.totalRefunds:      8000

Parity clamp-ordering assertion (settle_batch.rs:456-501 / PactSettler.sol:218-238):
  Step 1: pool-balance check fires FIRST (PoolDepleted decision)
  Step 2: ExposureCapClamped inference ALREADY SET from recordCallAndCapAccrual
  If pool balance < payableRefund -> status=PoolDepleted overwrites ExposureCapClamped
  Here pool is NOT depleted => status=Settled (breach=true path, full refund)

Pool-depleted clamp order locked by WP-05 OUTCOMES (c) seam 4:
  PactSettler.sol:220  if (ps.currentBalance < payableRefund) -> PoolDepleted
  PactSettler.sol:232  status = PoolDepleted (overwrites ExposureCapClamped if set)

---

## 2. Throwaway-wallet generation and storage plan

### Wallet identities needed

  DEPLOYER_EOA  -- already in .env as DEPLOYER_PRIVATE_KEY. NOT generated here.
  SETTLER_EOA   -- throwaway; must receive SETTLER_ROLE grant
  AGENT_EOA     -- throwaway; holds USDC + grants approve to PactSettler

### Generation command (to be run at execution, NOT NOW)

  cast wallet new   -- run ONCE per wallet, capture address + private key
  NEVER echo the private key to stdout in a form that could be captured by logs.
  Write ONLY to the gitignored .env file at:
  packages/program-evm/protocol-evm-v1/.env

### Keys to add to .env

  E2E_SETTLER_PRIVATE_KEY=<hex key>
  E2E_SETTLER_ADDRESS=<EIP-55 address>
  E2E_AGENT_PRIVATE_KEY=<hex key>
  E2E_AGENT_ADDRESS=<EIP-55 address>

The .env is confirmed gitignored in TWO places:
  packages/program-evm/protocol-evm-v1/.gitignore (line 10: .env)
  Root .gitignore (.env entry)

### Pre-execution gitignore verification

Before writing any key, run:
  git check-ignore -v packages/program-evm/protocol-evm-v1/.env
Expected output: the file is ignored. If NOT ignored, STOP-AND-ASK immediately.

### Post-execution cleanup

After Gate B approval and captain sign-off:
  Remove E2E_SETTLER_PRIVATE_KEY and E2E_AGENT_PRIVATE_KEY lines from .env.
  The throwaway wallets hold testnet USDC only; no recovery needed.
  Document cleanup in 07b-REPORT-gateB.md.

---

## 3. Funding budget (tight, exact)

Arc gas = USDC (6-decimal). All amounts in USDC micro-units (1 USDC = 1_000_000).

### Tx gas estimates

Arc gas price is low (USDC-native L1; typically 0.001-0.01 USDC per tx).
Using conservative estimate: 0.05 USDC (50_000 micro-units) per tx.
7 broadcast txs total (steps 1-7); negative step 7 is a cast send that reverts
(still costs gas for the failed tx attempt).

  Tx gas budget: 7 * 50_000 = 350_000 micro-units = 0.35 USDC

### USDC amounts needed per wallet

SETTLER_EOA:
  Gas for grant tx (deployer sends grant, so SETTLER_EOA pays no gas for step 1)
  SETTLER_EOA calls settleBatch x2 + the negative revert tx:
    3 txs * 50_000 = 150_000 micro-units gas
  SETTLER_EOA receives affiliate fees: +500 +500 (two calls) -- net positive
  Fund SETTLER_EOA with: 500_000 micro-units (0.5 USDC) for gas margin

AGENT_EOA:
  Needs USDC for 2x premium payments:
    premium * 2 = 10_000 * 2 = 20_000 micro-units
  Agent needs USDC approve gas + some margin: 2 txs * 50_000 = 100_000
  Fund AGENT_EOA with: 200_000 micro-units (0.2 USDC) for USDC + gas

DEPLOYER_EOA (already funded; faucet-confirmed):
  step 1: grantRole on PactSettler gas: 50_000
  step 2: registerEndpoint gas: 50_000
  step 3: USDC approve + topUp gas: 100_000 (2 txs)
  topUp amount: must cover step-6 breach refund of 8000 micro-units + margin
    topUp_amount = 50_000 micro-units (0.05 USDC); pool fully funded for the test
  Deployer USDC consumed: 50_000 (topUp) + 200_000 (gas) = 250_000 micro-units

### Total USDC budget from faucet perspective

  Already funded (deployer): confirmed by C2 ratification.
  Transfer to SETTLER_EOA: 500_000 micro-units
  Transfer to AGENT_EOA: 200_000 micro-units
  Total new transfers from deployer: 700_000 micro-units = 0.7 USDC

  Grand total consumed (deployer + throwaway wallets): ~1.0 USDC (conservative)

### Transfer commands (for reference, NOT executed now)

  cast send --private-key $DEPLOYER_PRIVATE_KEY \
    0x3600000000000000000000000000000000000000 \
    "transfer(address,uint256)" \
    $E2E_SETTLER_ADDRESS 500000 \
    --rpc-url https://rpc.testnet.arc.network

  cast send --private-key $DEPLOYER_PRIVATE_KEY \
    0x3600000000000000000000000000000000000000 \
    "transfer(address,uint256)" \
    $E2E_AGENT_ADDRESS 200000 \
    --rpc-url https://rpc.testnet.arc.network

---

## 4. Full tx sequence with exact cast commands, expected effects, and parity assertions

RPC: https://rpc.testnet.arc.network
Chain: 5042002
REGISTRY:  0x056BAC33546b5b51B8CF6f332379651f715B889C
POOL:      0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE
SETTLER:   0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f
USDC:      0x3600000000000000000000000000000000000000
DEPLOYER:  0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859

Variables used below (resolved from .env at execution time):
  $SETTLER_ADDR   = E2E_SETTLER_ADDRESS
  $AGENT_ADDR     = E2E_AGENT_ADDRESS
  $SLUG_HEX       = bytes16 hex of "e2e-test-slug-01" (computed via cast)
  TREASURY_ADDR   = DEPLOYER_EOA (== TREASURY_VAULT_ADDRESS per C2 ratification)

### Pre-flight reads (no gas, verify pre-conditions)

  # Confirm SETTLER_ROLE already granted to PactSettler (from WP-07 deploy)
  cast call $REGISTRY "hasRole(bytes32,address)(bool)" \
    $(cast keccak "SETTLER_ROLE") $SETTLER \
    --rpc-url https://rpc.testnet.arc.network
  # Expected: true (from WP-07 deploy; PactSettler already has SETTLER_ROLE)

  cast call $POOL "hasRole(bytes32,address)(bool)" \
    $(cast keccak "SETTLER_ROLE") $SETTLER \
    --rpc-url https://rpc.testnet.arc.network
  # Expected: true

  cast call $REGISTRY "protocolPaused()(bool)" \
    --rpc-url https://rpc.testnet.arc.network
  # Expected: false

  # Read deployer USDC balance before
  cast call $USDC "balanceOf(address)(uint256)" $DEPLOYER \
    --rpc-url https://rpc.testnet.arc.network

  # Compute slug bytes16 hex
  cast --from-utf8 "e2e-test-slug-01"
  # Result is the bytes16 value to use as $SLUG_HEX

---

### STEP 1 — grantRole(SETTLER_ROLE, SETTLER_EOA) on PactSettler

PURPOSE: Allow SETTLER_EOA to call settleBatch. PactSettler already holds
SETTLER_ROLE on registry+pool (from WP-07 deploy). This step grants
SETTLER_ROLE WITHIN PactSettler's own AccessControl to SETTLER_EOA.

NOTE on architecture: PactSettler.settleBatch is onlyRole(SETTLER_ROLE).
The SETTLER_ROLE on PactSettler itself is administered by its
DEFAULT_ADMIN_ROLE holder, which is registry.authority() = DEPLOYER_EOA
(PactSettler constructor: _grantRole(DEFAULT_ADMIN_ROLE, registry_.authority())).
So the deployer must call grantRole ON THE PactSettler CONTRACT.

Cast command:
  cast send \
    --private-key $DEPLOYER_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $SETTLER \
    "grantRole(bytes32,address)" \
    $(cast keccak "SETTLER_ROLE") \
    $SETTLER_ADDR

Expected effect:
  PactSettler.hasRole(SETTLER_ROLE, SETTLER_EOA) -> true
  tx status: success (1)

Verification read:
  cast call $SETTLER "hasRole(bytes32,address)(bool)" \
    $(cast keccak "SETTLER_ROLE") $SETTLER_ADDR \
    --rpc-url https://rpc.testnet.arc.network
  Expected: true

Parity assertion:
  settle_batch.rs:95-97 (Solana) — settler_signer must match
  SettlementAuthority.signer. EVM equivalent: onlyRole(SETTLER_ROLE).
  WP-04 OUTCOMES E2 (LOCKED): settleBatch is onlyRole(SETTLER_ROLE).
  LIVE-VERIFICATION confirmed: non-SETTLER call reverts
  AccessControlUnauthorizedAccount(AUTH, SETTLER_ROLE).

---

### STEP 2 — registerEndpoint with Treasury + Affiliate recipients

PURPOSE: Register the test endpoint with explicit fee recipients so
settleBatch can do the fee fan-out. Empty-default-template operational
constraint confirmed live (LIVE-VERIFICATION.md): MUST supply
feeRecipientsPresent=true with at least one Treasury entry.

FeeRecipient struct:
  struct FeeRecipient {
    uint8 kind;     // 0=Treasury, 1=Affiliate
    address destination;
    uint16 bps;
  }

Recipient array (count=2):
  [0] = (kind=0, destination=DEPLOYER_EOA, bps=1000)   // Treasury, 10%
  [1] = (kind=1, destination=SETTLER_ADDR, bps=500)     // Affiliate, 5%
  [2..7] = (kind=0, destination=0x000...000, bps=0)     // zero-padded

Calldata construction (using cast):
  The registerEndpoint signature:
    registerEndpoint(bytes16,uint64,uint16,uint32,uint64,uint64,bool,uint8,(uint8,address,uint16)[8])

  ABI-encoded via cast send with tuple args. Exact command:

  cast send \
    --private-key $DEPLOYER_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $REGISTRY \
    "registerEndpoint(bytes16,uint64,uint16,uint32,uint64,uint64,bool,uint8,(uint8,address,uint16)[8])" \
    $SLUG_HEX \
    10000 \
    0 \
    2000 \
    10000 \
    50000 \
    true \
    2 \
    "[(0,$DEPLOYER,1000),(1,$SETTLER_ADDR,500),(0,0x0000000000000000000000000000000000000000,0),(0,0x0000000000000000000000000000000000000000,0),(0,0x0000000000000000000000000000000000000000,0),(0,0x0000000000000000000000000000000000000000,0),(0,0x0000000000000000000000000000000000000000,0),(0,0x0000000000000000000000000000000000000000,0)]"

Expected effect:
  registry.isRegistered($SLUG_HEX) -> true
  EndpointRegistered event emitted (slug)
  ep.flatPremium = 10000
  ep.feeRecipientCount = 2
  ep.feeRecipients[0] = (0, DEPLOYER, 1000)
  ep.feeRecipients[1] = (1, SETTLER_ADDR, 500)
  tx status: success (1)

Verification reads:
  cast call $REGISTRY "isRegistered(bytes16)(bool)" $SLUG_HEX \
    --rpc-url https://rpc.testnet.arc.network
  Expected: true

  cast call $REGISTRY "getEndpoint(bytes16)((bool,uint64,uint16,uint32,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint8,(uint8,address,uint16)[8]))" \
    $SLUG_HEX --rpc-url https://rpc.testnet.arc.network
  Verify: feeRecipientCount=2, feeRecipients[0].bps=1000, [1].bps=500

Parity assertions:
  register_endpoint.rs: authority check -> slug validation -> fee validation
  (parse + substitute_treasury_destination + post-sub) -> EndpointAlreadyRegistered
  check -> write. Order confirmed LIVE (LIVE-VERIFICATION.md rows 1-5).
  FeeValidation.validate: MissingTreasuryEntry rejected (confirmed live).
  Treasury destination substituted to treasuryVault (DEPLOYER_EOA here per C2).
  bps sum = 1500 < maxTotalFeeBps = 3000: FeeBpsExceedsCap NOT triggered.

---

### STEP 3 — topUp the pool

PURPOSE: Fund the pool vault so the breach refund in step 6 can execute.
Access control: PactPool.topUp requires msg.sender == registry.authority()
(D3 LOCKED ruling: PactPool.sol:49 — UnauthorizedAuthority if not authority).
So DEPLOYER_EOA must call topUp.

Sub-step 3a — DEPLOYER approves PactPool to pull USDC:
  cast send \
    --private-key $DEPLOYER_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $USDC \
    "approve(address,uint256)" \
    $POOL \
    50000

  Expected: approval set; PactPool allowance for DEPLOYER >= 50000

Sub-step 3b — topUp:
  cast send \
    --private-key $DEPLOYER_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $POOL \
    "topUp(bytes16,uint64)" \
    $SLUG_HEX \
    50000

  Expected effect:
    pool.currentBalance += 50000  (stored as PoolState.currentBalance)
    pool.totalDeposits  += 50000
    pool.createdAt set (first topUp — D2 divergence, informational only)
    PoolToppedUp event emitted (slug, DEPLOYER, 50000)
    DEPLOYER USDC -= 50000
    POOL contract USDC += 50000
    tx status: success (1)

Verification reads:
  cast call $POOL "balanceOf(bytes16)((uint64,uint64,uint64,uint64))" \
    $SLUG_HEX --rpc-url https://rpc.testnet.arc.network
  Expected: (50000, 0, 0, <timestamp>)
  (currentBalance=50000, totalPremiums=0, totalRefunds=0, totalDeposits=50000)

Parity assertions:
  top_up_coverage_pool.rs: signer == coverage_pool.authority (ProtocolConfig.authority)
  EVM equivalent: msg.sender == registry.authority() (D3 LOCKED).
  cp.current_balance += amount (checked_add); cp.total_deposits += amount.
  D2 LOCKED: createdAt set lazily on first topUp (Solana sets at register) —
  informational divergence, never read by settle logic.

---

### STEP 4 — Agent USDC.approve(PactSettler, premium amount)

PURPOSE: Allow PactSettler to pull USDC from AGENT_EOA via transferFrom.
The Solana equivalent is the SPL Token delegate approve (pre-flight checked
via ATA buffer offsets 72-108; settle_batch.rs:295-313). EVM: standard
ERC-20 approve.

Approve at least 2x premium (both settlements) + margin:
  Amount to approve: 25000 (covers both calls + margin)

  cast send \
    --private-key $E2E_AGENT_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $USDC \
    "approve(address,uint256)" \
    $SETTLER \
    25000

  Expected:
    USDC.allowance(AGENT_EOA, SETTLER) >= 25000
    tx status: success (1)

Verification:
  cast call $USDC "allowance(address,address)(uint256)" \
    $AGENT_ADDR $SETTLER \
    --rpc-url https://rpc.testnet.arc.network
  Expected: 25000

Parity assertions:
  settle_batch.rs:295-313: pre-flight checks delegate field (opt==1) and
  delegated_amount >= premium. EVM uses try/catch on IERC20.transferFrom
  (PactSettler.sol:119-121) — if transferFrom reverts or returns false,
  premiumInOk=false -> DelegateFailed event, continue. With a valid approve
  of >= premium, transferFrom returns true -> premiumInOk=true -> proceeds.

---

### STEP 5 — PASS settlement (breach=false, refund=0)

PURPOSE: Prove the premium-debit + fee-split + pool-residual path end-to-end
with real USDC movement on Arc Testnet.

Pre-read balances (before broadcast):
  AGENT_ADDR USDC:     cast call $USDC "balanceOf(address)(uint256)" $AGENT_ADDR
  DEPLOYER USDC:       cast call $USDC "balanceOf(address)(uint256)" $DEPLOYER
  SETTLER_ADDR USDC:   cast call $USDC "balanceOf(address)(uint256)" $SETTLER_ADDR
  POOL USDC:           cast call $USDC "balanceOf(address)(uint256)" $POOL
  Pool state:          cast call $POOL "balanceOf(bytes16)(...)" $SLUG_HEX

callId for step 5: 0x00000000000000000000000000000001
timestamp: use current Unix time (cast block latest timestamp or $(date +%s))

SettlementEvent struct (ABI-encoded tuple):
  callId:                0x00000000000000000000000000000001
  agent:                 $AGENT_ADDR
  endpointSlug:          $SLUG_HEX
  premium:               10000
  refund:                0
  latencyMs:             500
  breach:                false
  feeRecipientCountHint: 2
  timestamp:             <current unix timestamp>

Cast command:
  cast send \
    --private-key $E2E_SETTLER_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $SETTLER \
    "settleBatch((bytes16,address,bytes16,uint64,uint64,uint32,bool,uint8,uint64)[])" \
    "[(0x00000000000000000000000000000001,$AGENT_ADDR,$SLUG_HEX,10000,0,500,false,2,$(date +%s))]"

Expected on-chain effect:

  1. PactSettler._settledCallIds[0x0...01] = true  (dedup sentinel set)
  2. IERC20.transferFrom(AGENT_EOA, POOL, 10000) succeeds -> premiumInOk=true
  3. pool.creditPremium(slug, 10000):
       pool.currentBalance = 50000 + 10000 = 60000
       pool.totalPremiums  = 0     + 10000 = 10000
  4. registry.recordCallAndCapAccrual(slug, 10000, false, 0):
       ep.totalCalls    = 1
       ep.totalPremiums = 10000
       ep.totalBreaches = 0 (breach=false)
       period check: block.timestamp > currentPeriodStart+3600? no (just registered)
       payableRefund = 0 (intendedRefund=0; cap clamp irrelevant)
       currentPeriodRefunds unchanged (payableRefund=0)
       returns payableRefund=0
  5. status = Settled (payableRefund=0 == ev.refund=0; no ExposureCapClamped)
  6. Fee fan-out:
       j=0: feeAmount = floor(10000 * 1000 / 10000) = 1000
            pool.payout(DEPLOYER, 1000)   -> DEPLOYER USDC +1000
       j=1: feeAmount = floor(10000 * 500 / 10000) = 500
            pool.payout(SETTLER_ADDR, 500) -> SETTLER_ADDR USDC +500
       totalFeePaid = 1500
       pool.debitForFees(slug, 1500):
         pool.currentBalance = 60000 - 1500 = 58500
  7. payableRefund=0: refund block skipped entirely
  8. actualRefund=0: recordRefundPaid NOT called
  9. emit CallSettled(
         callId=0x0...01, slug=$SLUG_HEX, agent=$AGENT_ADDR,
         premium=10000, refund=0, actualRefund=0,
         status=Settled(0), breach=false, latencyMs=500, timestamp=<ts>
     )

Post-broadcast balance assertions:
  AGENT_ADDR USDC:    before - 10000
  DEPLOYER USDC:      before - 50000 (topUp) + 1000 (treasury fee) = before - 49000
                      (net vs pre-topUp; DEPLOYER is both treasury and funder)
  SETTLER_ADDR USDC:  before + 500
  POOL USDC (ERC20):  50000 (topUp) + 10000 (premium-in) - 1000 (treasury) - 500 (aff)
                      = 58500
  pool.currentBalance = 58500
  pool.totalPremiums  = 10000
  ep.totalCalls       = 1
  ep.totalBreaches    = 0
  ep.totalPremiums    = 10000
  ep.totalRefunds     = 0

Parity assertions (settle_batch.rs):
  :360-368: cp.current_balance += premium; cp.total_premiums += premium (PASS)
  :385-395: ep.total_calls += 1; ep.total_premiums += premium; no breach (PASS)
  :396-399: period reset check (PASS - no reset needed)
  :400-415: intended_refund_after_cap=0; no cap clamp applied (PASS)
  :426-453: fee fan-out: floor div each bps; pool debited by total_fee_paid (PASS)
  :456: intended_refund_after_cap=0; refund block skipped (PASS)
  status=Settled (0) matches SettlementStatus::Settled=0 (PASS)

---

### STEP 6 — BREACH settlement (breach=true, refund=8000)

PURPOSE: Prove the refund path, pool debit, totalRefunds, totalBreaches,
exposure-cap non-trigger, and PoolDepleted non-trigger end-to-end.

Pre-read balances (before broadcast):
  Same set as step 5 (capture post-step-5 values as the "before" baseline)

callId for step 6: 0x00000000000000000000000000000002 (unique from step 5)

SettlementEvent:
  callId:                0x00000000000000000000000000000002
  agent:                 $AGENT_ADDR
  endpointSlug:          $SLUG_HEX
  premium:               10000
  refund:                8000
  latencyMs:             3000
  breach:                true
  feeRecipientCountHint: 2
  timestamp:             <current unix timestamp>

Cast command:
  cast send \
    --private-key $E2E_SETTLER_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $SETTLER \
    "settleBatch((bytes16,address,bytes16,uint64,uint64,uint32,bool,uint8,uint64)[])" \
    "[(0x00000000000000000000000000000002,$AGENT_ADDR,$SLUG_HEX,10000,8000,3000,true,2,$(date +%s))]"

Expected on-chain effect:

  1. _settledCallIds[0x0...02] = true
  2. IERC20.transferFrom(AGENT_EOA, POOL, 10000) -> premiumInOk=true
  3. pool.creditPremium(slug, 10000):
       pool.currentBalance = 58500 + 10000 = 68500
       pool.totalPremiums  = 10000 + 10000 = 20000
  4. registry.recordCallAndCapAccrual(slug, 10000, true, 8000):
       ep.totalCalls    = 2
       ep.totalPremiums = 20000
       ep.totalBreaches = 1 (breach=true)
       period check: no reset (within first hour)
       payableRefund = 8000
       cap check: exposureCapPerHour=50000; currentPeriodRefunds=0 (no prior refunds)
         capRemaining = 50000 - 0 = 50000
         8000 <= 50000 -> NO clamp -> payableRefund stays 8000
       currentPeriodRefunds = 0 + 8000 = 8000
       returns payableRefund=8000
  5. status = Settled (payableRefund=8000 == ev.refund=8000; no ExposureCapClamped)
  6. Fee fan-out: same as step 5
       treasury_fee = 1000; affiliate_fee = 500; totalFeePaid = 1500
       pool.currentBalance = 68500 - 1500 = 67000
  7. Refund check: payableRefund=8000 > 0
       ps.currentBalance = 67000; payableRefund=8000; 67000 >= 8000 -> NOT PoolDepleted
       pool.payout(AGENT_EOA, 8000) -> AGENT_EOA USDC +8000
       pool.debitForRefund(slug, 8000):
         pool.currentBalance = 67000 - 8000 = 59000
         pool.totalRefunds   = 0 + 8000 = 8000
       actualRefund = 8000
  8. registry.recordRefundPaid(slug, 8000):
       ep.totalRefunds = 0 + 8000 = 8000
  9. emit CallSettled(
         callId=0x0...02, slug=$SLUG_HEX, agent=$AGENT_ADDR,
         premium=10000, refund=8000, actualRefund=8000,
         status=Settled(0), breach=true, latencyMs=3000, timestamp=<ts>
     )

Post-broadcast balance assertions (vs post-step-5 baseline):
  AGENT_ADDR USDC:    - 10000 (premium) + 8000 (refund) = net -2000
  DEPLOYER USDC:      + 1000 (treasury fee)
  SETTLER_ADDR USDC:  + 500  (affiliate fee)
  POOL USDC (ERC20):  58500 + 10000 - 1500 - 8000 = 59000
  pool.currentBalance = 59000
  pool.totalPremiums  = 20000
  pool.totalRefunds   = 8000
  ep.totalCalls       = 2
  ep.totalBreaches    = 1
  ep.totalRefunds     = 8000

Parity assertions (settle_batch.rs):
  :360-368: cp.current_balance += premium; cp.total_premiums += premium (PASS)
  :385-395: ep.total_calls+=1; ep.total_premiums+=premium; ep.total_breaches+=1 (PASS)
  :396-399: no period reset (PASS)
  :400-415: intended_refund_after_cap=8000; capRemaining=50000; no clamp (PASS)
  :426-453: fee fan-out same as step 5 (PASS)
  :456-501: pool_balance=67000 >= intended_refund_after_cap=8000 -> NOT PoolDepleted
             transfer executed; actual_refund_lamports=8000 (PASS)
  :480-490: cp.current_balance -= 8000; cp.total_refunds += 8000 (PASS)
  :493-499: ep.total_refunds += actual_refund_lamports (PASS)
  Clamp order: ExposureCapClamped inference (payableRefund < ev.refund? no) ->
               PoolDepleted check (balance >= payableRefund? yes, skip) ->
               status remains Settled (PASS)
  PoolDepleted seam: PactSettler.sol:220 check FIRST (pool-balance), THEN
                     ExposureCapClamped overwrite logic at :192.
                     WP-05 OUTCOMES (c) seam 4 confirmed. (PASS)

---

### STEP 7 — Negative: duplicate callId revert (dedup live)

PURPOSE: Confirm DuplicateCallId revert for a replayed callId and that the
error selector matches the parity-verified selector from the simulation.

Re-submit the step-5 callId (0x00000000000000000000000000000001):

  cast send \
    --private-key $E2E_SETTLER_PRIVATE_KEY \
    --rpc-url https://rpc.testnet.arc.network \
    --chain-id 5042002 \
    $SETTLER \
    "settleBatch((bytes16,address,bytes16,uint64,uint64,uint32,bool,uint8,uint64)[])" \
    "[(0x00000000000000000000000000000001,$AGENT_ADDR,$SLUG_HEX,10000,0,500,false,2,$(date +%s))]"

  Expected: tx reverts with DuplicateCallId
  Error selector: use cast decode-error or check receipt revertReason
  Confirmed selector from simulation (LIVE-VERIFICATION.md): NOT explicitly
  listed for DuplicateCallId in that doc, but the error is in PactErrors.sol.
  Expected selector: keccak256("DuplicateCallId()")[0:4]
  Verify with: cast sig "DuplicateCallId()"

  Note: the revert MUST fire before any premium debit (dedup SET fires at
  PactSettler.sol:111 BEFORE premium-in at :119). AGENT_EOA balance UNCHANGED.

Parity assertion:
  settle_batch.rs:194-196: !call_record.is_data_empty() -> DuplicateCallId
  EVM: _settledCallIds[ev.callId] == true -> revert DuplicateCallId (LOCKED E4)
  GATE-A E4 LOCKED: dedup SET before premium-in; DelegateFailed events also
  consume the callId and are not retryable.

Optional: BatchTooLarge check (informational, no budget risk)
  If time permits, send a batch of 51 events -> expect BatchTooLarge revert.
  ArcConfig.MAX_BATCH_SIZE = 50; 51 events -> revert (strict >).
  No USDC movement (fast-revert before loop). Not required for Gate B.

---

## 5. Balance and event assertion checklist

After ALL steps complete, capture and record in 07b-REPORT-gateB.md:

### USDC balances (cast call $USDC "balanceOf(address)(uint256)" <addr>)

  [ ] AGENT_EOA: started_with - 10000 - 10000 + 8000 = started_with - 12000
  [ ] DEPLOYER:  treasury received +1000+1000=+2000 fees; paid topUp -50000;
                 net from USDC balance perspective: -48000 from pre-step-3 balance
  [ ] SETTLER_ADDR: received +500+500=+1000 affiliate fees
  [ ] POOL contract: 50000 (topUp) + 10000 + 10000 (premiums) - 1500 - 1500 (fees) - 8000 (refund)
                     = 58000 net in pool contract USDC balance

### Pool state (cast call $POOL "balanceOf(bytes16)..." $SLUG_HEX)

  [ ] currentBalance: 59000
  [ ] totalPremiums:  20000
  [ ] totalRefunds:   8000
  [ ] totalDeposits:  50000

### Endpoint stats (cast call $REGISTRY "getEndpoint(bytes16)..." $SLUG_HEX)

  [ ] totalCalls:    2
  [ ] totalBreaches: 1
  [ ] totalPremiums: 20000
  [ ] totalRefunds:  8000
  [ ] paused:        false

### Dedup sentinels

  [ ] _settledCallIds is private; inferred from step 7 revert (DuplicateCallId
      confirms the sentinel is set for 0x0...01)
  [ ] callId 0x0...02 also consumed (would revert on replay; optional check)

### Events (from tx receipts / cast receipt --json)

  [ ] Step 2: EndpointRegistered(slug) on registry
  [ ] Step 3a: Approval on USDC
  [ ] Step 3b: PoolToppedUp(slug, DEPLOYER, 50000) on pool
  [ ] Step 4: Approval on USDC
  [ ] Step 5: CallSettled(callId=0x0...01, slug, agent, 10000, 0, 0,
              Settled=0, false, 500, ts)
  [ ] Step 6: CallSettled(callId=0x0...02, slug, agent, 10000, 8000, 8000,
              Settled=0, true, 3000, ts)
  [ ] Step 7: tx reverted (DuplicateCallId); no CallSettled event

---

## 6. Rollback and cleanup plan

### If a step fails mid-sequence (except step 7 which is expected to revert)

  - STOP. Do not retry or attempt a workaround.
  - Capture the full tx hash, receipt, and revert reason.
  - Write a CRITICAL finding section in 07b-REPORT-gateB.md.
  - If the failure indicates a parity discrepancy vs settle_batch.rs: this is
    a CRITICAL parity defect. DO NOT edit any contract. Escalate via the
    report file and HALT.
  - If the failure is an operational issue (insufficient funds, wrong calldata
    encoding): fix the operational issue, re-read the balance state, and
    resume from the failed step (using a new callId if step 5/6 dedup was
    consumed by a partial attempt).

### Post-Gate-B cleanup

  - Remove E2E_SETTLER_PRIVATE_KEY and E2E_AGENT_PRIVATE_KEY from
    packages/program-evm/protocol-evm-v1/.env
  - The throwaway wallet addresses (E2E_SETTLER_ADDRESS, E2E_AGENT_ADDRESS)
    may remain in .env as non-sensitive documentation of the test run.
  - Confirm git status shows no sensitive file staged:
      git diff --name-only HEAD
      git status
  - Any residual USDC in SETTLER_EOA / AGENT_EOA remains on Arc Testnet.
    Faucet USDC; no recovery action needed.

### Tree cleanliness

  At no point does this plan create any file in packages/program-evm/ other
  than appending to the gitignored .env. All artifacts go to
  .planning/phases/07-wp-evm-07-arc-deploy/.

---

## 7. Hard-constraint compliance checklist

  [x] NO contract change — only test scripts/docs and .env modifications
  [x] Private keys: never echo, never committed, .env is gitignored (confirmed
      in both root .gitignore and packages/program-evm/protocol-evm-v1/.gitignore)
  [x] File-scoped conventional commits only (test:, docs: prefixes)
  [x] NO push / NO PR comment until captain Gate B approval
  [x] Never run a pact skill installer / pact --help
  [x] Tree expected state: only ?? .claude/pr-reviews/ untracked; no contamination
  [x] No parity ambiguity unresolved below -- no STOP-AND-ASK required for this plan

---

## 8. Pre-broadcast stop-and-ask

Per the brief: even after Gate A approval, the crew will post a one-line
readiness note in this report file IMMEDIATELY BEFORE the first broadcast
(the grantRole tx in step 1). That note will read:

  "READY TO BROADCAST -- awaiting captain release. All pre-flight reads
   complete. Step 1 (grantRole) is the first tx. USDC balances confirmed.
   Gitignore confirmed. Keys in .env only. Standing by."

The captain releases the broadcast by confirming in 07b-CAPTAIN-GATE-A-VERDICT.md
AND providing a separate explicit go for fund-moving broadcasts.

---

## 9. Open questions / potential parity ambiguities

None requiring a STOP-AND-ASK. All economics are fully derived from
settle_batch.rs. The following are noted for completeness:

A. treasuryVault == DEPLOYER_EOA (C2 testnet simplification): the treasury
   fee payout in steps 5 and 6 goes to the deployer EOA itself, so the
   "deployer USDC" balance simultaneously increases by treasury fees and
   decreased by topUp. This is correct per C2 ratification and does not
   affect the fee arithmetic (the pool.payout call goes to the stored
   treasuryVault regardless of who that is).

B. SETTLER_EOA as affiliate destination: SETTLER_EOA receives affiliate fees
   from its own settleBatch calls. This is a testnet convenience (one funded
   wallet acts as affiliate). No economic or access-control issue.

C. timestamp encoding: cast $(date +%s) returns a Unix timestamp as a decimal
   integer. Cast will encode it as uint64 in the tuple. The timestamp > now
   guard (PactSettler.sol:81; settle_batch.rs:158) fires if timestamp >
   block.timestamp. Using current $(date +%s) at broadcast time guarantees
   timestamp <= block.timestamp (block time is not in the future vs wall clock).
   A small margin (send immediately after reading the timestamp) ensures no
   race condition.

D. feeRecipientCountHint=2 matches ep.feeRecipientCount=2 stored at
   registerEndpoint. RecipientCoverageMismatch does NOT fire. Confirmed by
   the guard at PactSettler.sol:103-104 / settle_batch.rs:213-215.

---

STATUS: GATE A PLAN COMPLETE. Awaiting 07b-CAPTAIN-GATE-A-VERDICT.md.
No wallet generated. No funds moved. No broadcast. No key ever echoed.
