/**
 * Pact-0G end-to-end demo CLI — 0G APAC Hackathon submission.
 *
 * Runs the full insured-call lifecycle on Aristotle mainnet (chain 16661)
 * against the real XSwap Bridged USDC.e premium token in one tsx invocation.
 * Produces the on-chain artifacts the HackQuest submission form needs:
 * PactCore address, settle_batch tx hash, 0G Storage rootHash placeholder.
 *
 * Flow:
 *   1. read balances (native $0G + USDC.e)
 *   2. deploy PactCore — admin/settler/treasury all bound to deployer
 *   3. approve PactCore to spend USDC.e from the deployer (agent role)
 *   4. registerEndpoint("demo-chat")
 *   5. topUpCoveragePool — seed pool liquidity for breach refunds
 *   6. settleBatch — one non-breach call, one breach call
 *   7. print Submission Artifacts block
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  encodeAbiParameters,
  hexToBytes,
  bytesToHex,
  formatEther,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pactCoreAbi } from '@pact-network/protocol-zerog-client';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const ARISTOTLE = {
  id: 16661,
  name: '0G Mainnet (Aristotle)',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: ['https://evmrpc.0g.ai'] } },
  blockExplorers: { default: { name: 'ChainScan', url: 'https://chainscan.0g.ai' } },
} as const;

const USDC_DECIMALS = 6;
const PREMIUM = 10_000n;          // 0.01 USDC.e per call
const POOL_TOPUP = 500_000n;      // 0.5 USDC.e seed
const REFUND_ON_BREACH = 10_000n; // 0.01 USDC.e refund when call breaches SLO

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

// ─────────────────────────────────────────────────────────────────────────
// Env + clients
// ─────────────────────────────────────────────────────────────────────────

const RPC_URL = required('RPC_URL');
const DEPLOYER_PK = required('DEPLOYER_PK') as Hex;
const USDC_ADDRESS = required('USDC_ADDRESS') as Address;
const PACT_CORE_PRESET = process.env.PACT_CORE_ADDRESS as Address | undefined;

const account = privateKeyToAccount(DEPLOYER_PK);
const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: ARISTOTLE, transport });
const walletClient = createWalletClient({ account, chain: ARISTOTLE, transport });

// ─────────────────────────────────────────────────────────────────────────
// Pretty output
// ─────────────────────────────────────────────────────────────────────────

const BAR = '═'.repeat(72);
const STAGE = (n: number, total: number, label: string) =>
  console.log(`\n[${n}/${total}] ${label}`);
const explorerTx = (h: Hex) => `${ARISTOTLE.blockExplorers.default.url}/tx/${h}`;
const explorerAddr = (a: Address) => `${ARISTOTLE.blockExplorers.default.url}/address/${a}`;
const storagescan = (root: Hex) =>
  `https://storagescan.0g.ai/file/${root}`;

function required(key: string): string {
  const v = process.env[key];
  if (!v || /^0x0+$/.test(v) || v === '') {
    throw new Error(`Missing required env var ${key}`);
  }
  return v;
}

// Deterministic 16-byte slug from an ASCII label.
function slug16(label: string): Hex {
  if (label.length > 16) throw new Error(`slug too long: ${label}`);
  const bytes = new Uint8Array(16);
  const enc = new TextEncoder().encode(label);
  bytes.set(enc, 0);
  return bytesToHex(bytes);
}

// Random 16-byte callId (UUID v4 high half is fine for demo).
function randomCallId(): Hex {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// 32-byte rootHash placeholder. Real settlers would upload an evidence blob
// to 0G Storage and use the returned rootHash. For the hackathon demo we
// derive a deterministic 32-byte hash from the callId so the on-chain
// CallSettled event has a non-zero rootHash to display.
function evidenceHash(callId: Hex): Hex {
  return (callId + '00000000000000000000000000000000') as Hex;
}

// ─────────────────────────────────────────────────────────────────────────
// Foundry artifact loader (for the deploy step)
// ─────────────────────────────────────────────────────────────────────────

function loadBytecode(): Hex {
  const here = dirname(fileURLToPath(import.meta.url));
  const artifact = join(
    here,
    '..',
    '..',
    'packages',
    'protocol-zerog-contracts',
    'out',
    'PactCore.sol',
    'PactCore.json',
  );
  const json = JSON.parse(readFileSync(artifact, 'utf8'));
  return json.bytecode.object as Hex;
}

// ─────────────────────────────────────────────────────────────────────────
// Flow
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(BAR);
  console.log('  Pact-0G end-to-end demo — 0G APAC Hackathon');
  console.log(BAR);

  // ── 1. Balances ────────────────────────────────────────────────────────
  STAGE(1, 6, 'Wallet & balances');
  const [nativeBal, usdcBal, usdcSymbol] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }),
  ]);
  console.log(`  Deployer:    ${account.address}`);
  console.log(`  $0G (gas):   ${formatEther(nativeBal)}`);
  console.log(`  ${usdcSymbol.padEnd(11)} ${formatUnits(usdcBal, USDC_DECIMALS)}`);
  if (nativeBal === 0n) throw new Error('Deployer holds zero $0G — fund native gas first.');
  if (usdcBal < POOL_TOPUP + PREMIUM * 2n) {
    throw new Error(
      `Deployer holds ${formatUnits(usdcBal, USDC_DECIMALS)} ${usdcSymbol} — need at least ${formatUnits(POOL_TOPUP + PREMIUM * 2n, USDC_DECIMALS)} for the demo.`,
    );
  }

  // ── 2. Deploy PactCore (or reuse) ──────────────────────────────────────
  let pactCore: Address;
  let deployTx: Hex | null = null;
  if (PACT_CORE_PRESET) {
    STAGE(2, 6, `Using existing PactCore at ${PACT_CORE_PRESET}`);
    pactCore = PACT_CORE_PRESET;
  } else {
    STAGE(2, 6, 'Deploying PactCore (admin = settler = treasury = deployer)');
    const bytecode = loadBytecode();
    deployTx = await walletClient.deployContract({
      abi: pactCoreAbi,
      bytecode,
      args: [account.address, account.address, account.address, USDC_ADDRESS],
    });
    console.log(`  deploy tx:   ${explorerTx(deployTx)}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTx });
    if (!receipt.contractAddress) throw new Error('PactCore deploy returned no contractAddress');
    pactCore = receipt.contractAddress;
    console.log(`  PactCore:    ${explorerAddr(pactCore)}`);
  }

  // ── 3. Approve PactCore to spend USDC.e ────────────────────────────────
  STAGE(3, 6, `Approving PactCore to spend ${usdcSymbol} (max)`);
  const approveTx = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [pactCore, 2n ** 256n - 1n],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log(`  approve tx:  ${explorerTx(approveTx)}`);

  // ── 4. Register endpoint ───────────────────────────────────────────────
  STAGE(4, 6, 'Registering endpoint "demo-chat"');
  const slug = slug16('demo-chat');
  const registerTx = await walletClient.writeContract({
    address: pactCore,
    abi: pactCoreAbi,
    functionName: 'registerEndpoint',
    args: [
      slug,
      {
        agentTokenId: 0n,
        flatPremium: PREMIUM,
        percentBps: 0,
        imputedCost: 0n,
        latencySloMs: 5_000,
        exposureCapPerHour: 1_000_000n,
        currentPeriodStart: 0n,
        currentPeriodRefunds: 0n,
        totalCalls: 0n,
        totalBreaches: 0n,
        totalPremiums: 0n,
        totalRefunds: 0n,
        lastUpdated: 0n,
        paused: false,
        exists: false,
      },
      [
        // Treasury at 10% — receives ~10% of every premium, rest residual to pool.
        { kind: 0, destination: account.address, bps: 1_000 },
      ],
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: registerTx });
  console.log(`  register tx: ${explorerTx(registerTx)}`);
  console.log(`  slug:        ${slug} ("demo-chat")`);
  console.log(`  premium:     ${formatUnits(PREMIUM, USDC_DECIMALS)} ${usdcSymbol} per call`);

  // ── 5. Top up coverage pool ────────────────────────────────────────────
  STAGE(5, 6, `Topping up coverage pool with ${formatUnits(POOL_TOPUP, USDC_DECIMALS)} ${usdcSymbol}`);
  const topupTx = await walletClient.writeContract({
    address: pactCore,
    abi: pactCoreAbi,
    functionName: 'topUpCoveragePool',
    args: [slug, POOL_TOPUP],
  });
  await publicClient.waitForTransactionReceipt({ hash: topupTx });
  console.log(`  topup tx:    ${explorerTx(topupTx)}`);

  // ── 6. Settle two calls (one OK, one breach) ───────────────────────────
  STAGE(6, 6, 'Settling 2 calls — one non-breach, one breach');
  const now = BigInt(Math.floor(Date.now() / 1000));
  const callOk = randomCallId();
  const callBreach = randomCallId();
  const evidenceOk = evidenceHash(callOk);
  const evidenceBreach = evidenceHash(callBreach);

  const settleTx = await walletClient.writeContract({
    address: pactCore,
    abi: pactCoreAbi,
    functionName: 'settleBatch',
    args: [
      [
        {
          callId: callOk,
          slug,
          agent: account.address,
          breach: false,
          premiumWei: PREMIUM,
          refundWei: 0n,
          timestamp: now,
          rootHash: evidenceOk,
        },
        {
          callId: callBreach,
          slug,
          agent: account.address,
          breach: true,
          premiumWei: PREMIUM,
          refundWei: REFUND_ON_BREACH,
          timestamp: now,
          rootHash: evidenceBreach,
        },
      ],
    ],
  });
  const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleTx });
  console.log(`  settle tx:   ${explorerTx(settleTx)}`);
  console.log(`  status:      ${settleReceipt.status}`);
  console.log(`  gas used:    ${settleReceipt.gasUsed}`);
  console.log(`  callId 1:    ${callOk}  (non-breach)`);
  console.log(`  callId 2:    ${callBreach}  (breach → refund ${formatUnits(REFUND_ON_BREACH, USDC_DECIMALS)} ${usdcSymbol})`);

  // ── Submission artifacts ───────────────────────────────────────────────
  console.log('\n' + BAR);
  console.log('  SUBMISSION ARTIFACTS — paste these into the HackQuest form');
  console.log(BAR);
  console.log(`  Network:            0G Mainnet (Aristotle, chain 16661)`);
  console.log(`  Premium token:      ${USDC_ADDRESS} (XSwap Bridged USDC.e)`);
  console.log(`  PactCore:           ${explorerAddr(pactCore)}`);
  if (deployTx) console.log(`  Deploy tx:          ${explorerTx(deployTx)}`);
  console.log(`  Register tx:        ${explorerTx(registerTx)}`);
  console.log(`  Pool topup tx:      ${explorerTx(topupTx)}`);
  console.log(`  Settle batch tx:    ${explorerTx(settleTx)}`);
  console.log(`  Evidence hash 1:    ${evidenceOk}`);
  console.log(`  Evidence hash 2:    ${evidenceBreach}`);
  console.log(BAR);
}

main().catch((err) => {
  console.error('\nDEMO FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
