#!/usr/bin/env tsx
/**
 * pact-0g — agent-facing CLI for the Pact-0G insurance protocol.
 *
 * Mirrors the shape of the Solana `pact pay` CLI: agent runs one command,
 * the protocol charges a premium, optionally refunds on breach, settles
 * on-chain on 0G mainnet. Output is in agent-perspective terms —
 * balance before/after, premium debited, refund credited, fees split.
 *
 * Two wallets:
 *   agent   — holds USDC.e, signs the one-time approve() to PactCore
 *   settler — signs settleBatch on behalf of the agent (it's the
 *             endpoint's registered settlement authority)
 *
 * In production these are owned by different parties; for hackathon
 * scope they live in the same .env so one process can drive the demo.
 */

import 'dotenv/config';
import { cac } from 'cac';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatEther,
  formatUnits,
  bytesToHex,
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
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
]);

// ─────────────────────────────────────────────────────────────────────────
// Env + clients
// ─────────────────────────────────────────────────────────────────────────

function req(key: string): string {
  const v = process.env[key];
  if (!v || /^0x0+$/.test(v)) throw new Error(`Missing env: ${key}`);
  return v;
}

const RPC_URL = req('RPC_URL');
const USDC = req('USDC_ADDRESS') as Address;
const PACT_CORE = req('PACT_CORE_ADDRESS') as Address;
const SLUG_LABEL = process.env.ENDPOINT_SLUG ?? 'demo-chat';

const agentAccount = privateKeyToAccount(req('AGENT_PK') as Hex);
const settlerAccount = privateKeyToAccount(req('SETTLER_PK') as Hex);

const transport = http(RPC_URL, { timeout: 30_000 });
const publicClient = createPublicClient({ chain: ARISTOTLE, transport });
const agentWallet = createWalletClient({ account: agentAccount, chain: ARISTOTLE, transport });
const settlerWallet = createWalletClient({ account: settlerAccount, chain: ARISTOTLE, transport });

// 0G mainnet's RPC occasionally returns "tx not found" for ~5–10s after
// submission even when the tx is already mined. Manual poll loop tolerates
// that better than viem's built-in waitForTransactionReceipt.
async function waitTx(hash: Hex) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const r = await publicClient.getTransactionReceipt({ hash });
      if (r && r.blockNumber) return r;
    } catch {
      /* receipt not found yet — keep polling */
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function slug16(label: string): Hex {
  if (label.length > 16) throw new Error(`slug too long: ${label}`);
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode(label), 0);
  return bytesToHex(bytes);
}

function randomCallId(): Hex {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function evidenceHash(callId: Hex): Hex {
  return (callId + '00000000000000000000000000000000') as Hex;
}

const explorerTx = (h: Hex) => `${ARISTOTLE.blockExplorers.default.url}/tx/${h}`;
const short = (h: string, head = 6, tail = 4) =>
  h.length <= head + tail + 2 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;

function fmtUsdc(wei: bigint): string {
  return formatUnits(wei, USDC_DECIMALS);
}

function tag(label: string, value: string) {
  console.log(`  [${label.padEnd(9)}] ${value}`);
}

function rule() {
  console.log('  ' + '─'.repeat(70));
}

async function readBalances(addr: Address) {
  const [native, usdc, allowance, symbol] = await Promise.all([
    publicClient.getBalance({ address: addr }),
    publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [addr],
    }),
    publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [addr, PACT_CORE],
    }),
    publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }),
  ]);
  return { native, usdc, allowance, symbol };
}

async function readEndpoint(slug: Hex) {
  const cfg = await publicClient.readContract({
    address: PACT_CORE,
    abi: pactCoreAbi,
    functionName: 'endpointConfig',
    args: [slug],
  });
  return {
    exists: cfg[14] as boolean,
    paused: cfg[13] as boolean,
    flatPremium: cfg[1] as bigint,
    latencySloMs: Number(cfg[4]),
    exposureCapPerHour: cfg[5] as bigint,
    totalCalls: cfg[8] as bigint,
    totalBreaches: cfg[9] as bigint,
    totalPremiums: cfg[10] as bigint,
    totalRefunds: cfg[11] as bigint,
  };
}

async function readPool(slug: Hex) {
  const p = await publicClient.readContract({
    address: PACT_CORE,
    abi: pactCoreAbi,
    functionName: 'coveragePool',
    args: [slug],
  });
  return { balance: p[0] as bigint, totalDeposits: p[1] as bigint };
}

// ─────────────────────────────────────────────────────────────────────────
// Subcommands
// ─────────────────────────────────────────────────────────────────────────

async function cmdBalance() {
  const b = await readBalances(agentAccount.address);
  console.log('');
  console.log('  Pact-0G — agent wallet');
  rule();
  tag('wallet', agentAccount.address);
  tag('$0G', formatEther(b.native));
  tag(b.symbol, fmtUsdc(b.usdc));
  tag('approved', `${fmtUsdc(b.allowance)} ${b.symbol} to PactCore`);
  console.log('');
}

async function cmdApprove() {
  const b = await readBalances(agentAccount.address);
  console.log('');
  console.log('  Approving PactCore to debit USDC.e from the agent on settle');
  rule();
  tag('agent', agentAccount.address);
  tag('current', `${fmtUsdc(b.allowance)} ${b.symbol}`);

  if (b.allowance > 1_000_000n) {
    tag('action', 'already-sufficient — skipping tx');
    console.log('');
    return;
  }

  const hash = await agentWallet.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [PACT_CORE, 2n ** 256n - 1n],
  });
  tag('tx', explorerTx(hash));
  await waitTx(hash);
  const after = await readBalances(agentAccount.address);
  tag('after', `${fmtUsdc(after.allowance)} ${after.symbol}`);
  console.log('');
}

async function cmdEndpoint(slugLabel: string) {
  const slug = slug16(slugLabel);
  const ep = await readEndpoint(slug);
  console.log('');
  console.log(`  Pact-0G endpoint "${slugLabel}"`);
  rule();
  tag('slug', `${slug} (${slugLabel})`);
  tag('exists', String(ep.exists));
  if (!ep.exists) {
    console.log('');
    return;
  }
  tag('paused', String(ep.paused));
  tag('premium', `${fmtUsdc(ep.flatPremium)} USDC.e per call`);
  tag('SLO', `${ep.latencySloMs} ms`);
  tag('cap/hr', `${fmtUsdc(ep.exposureCapPerHour)} USDC.e refunds`);
  tag('calls', String(ep.totalCalls));
  tag('breaches', String(ep.totalBreaches));
  tag('premiums', `${fmtUsdc(ep.totalPremiums)} USDC.e lifetime`);
  tag('refunds', `${fmtUsdc(ep.totalRefunds)} USDC.e lifetime`);
  console.log('');
}

async function cmdPool(slugLabel: string) {
  const slug = slug16(slugLabel);
  const pool = await readPool(slug);
  console.log('');
  console.log(`  Pact-0G coverage pool "${slugLabel}"`);
  rule();
  tag('balance', `${fmtUsdc(pool.balance)} USDC.e (available for refunds)`);
  tag('deposits', `${fmtUsdc(pool.totalDeposits)} USDC.e (lifetime in)`);
  console.log('');
}

async function cmdPay(opts: { breach?: boolean; latencyMs?: number }) {
  const slug = slug16(SLUG_LABEL);
  const ep = await readEndpoint(slug);
  if (!ep.exists) throw new Error(`Endpoint "${SLUG_LABEL}" not registered.`);
  if (ep.paused) throw new Error(`Endpoint "${SLUG_LABEL}" is paused.`);

  const before = await readBalances(agentAccount.address);
  if (before.allowance < ep.flatPremium) {
    throw new Error(
      `Agent allowance ${fmtUsdc(before.allowance)} ${before.symbol} < premium ${fmtUsdc(ep.flatPremium)}. Run: pact-0g approve`,
    );
  }
  if (before.usdc < ep.flatPremium) {
    throw new Error(
      `Agent ${before.symbol} balance ${fmtUsdc(before.usdc)} < premium ${fmtUsdc(ep.flatPremium)}.`,
    );
  }

  // Simulate the inference call. In production the proxy makes a real call
  // to 0G Compute, times it, and classifies against the SLO. Here we either
  // hit the success path (~latencyMs default 800 ms) or force a breach.
  const isBreach = !!opts.breach;
  const latencyMs = opts.latencyMs ?? (isBreach ? 12_000 : 800);
  const httpStatus = isBreach ? 503 : 200;

  console.log('');
  console.log(`  Pact-0G — insured call to "${SLUG_LABEL}"`);
  rule();
  tag('agent', agentAccount.address);
  tag('balance', `${fmtUsdc(before.usdc)} USDC.e`);
  tag('endpoint', `${SLUG_LABEL} (${fmtUsdc(ep.flatPremium)} USDC.e / call, ${ep.latencySloMs}ms SLO)`);
  console.log('');
  tag('call', `POST /v1/${SLUG_LABEL}/chat   { "messages": [{ "role": "user", "content": "..." }] }`);

  await new Promise((r) => setTimeout(r, Math.min(latencyMs, 1500)));

  const breachDetected = isBreach || latencyMs > ep.latencySloMs || httpStatus >= 500;
  tag('response', `HTTP ${httpStatus} (${latencyMs}ms ${breachDetected ? '> SLO → BREACH' : '< SLO → ok'})`);
  console.log('');

  const callId = randomCallId();
  const rootHash = evidenceHash(callId);
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const ts = block.timestamp - 5n;
  const refundWei = breachDetected ? ep.flatPremium : 0n;

  tag('classifier', breachDetected ? 'breach=true → refund' : 'breach=false → premium only');
  const hash = await settlerWallet.writeContract({
    address: PACT_CORE,
    abi: pactCoreAbi,
    functionName: 'settleBatch',
    args: [
      [
        {
          callId,
          slug,
          agent: agentAccount.address,
          breach: breachDetected,
          premiumWei: ep.flatPremium,
          refundWei,
          timestamp: ts,
          rootHash,
        },
      ],
    ],
  });
  tag('settle', short(hash, 10, 6) + '  ' + explorerTx(hash));
  const receipt = await waitTx(hash);
  tag('status', receipt.status);
  tag('gas', String(receipt.gasUsed));

  const after = await readBalances(agentAccount.address);
  const delta = after.usdc - before.usdc;
  const absDelta = delta < 0n ? -delta : delta;
  const deltaStr = delta === 0n ? '±0' : (delta > 0n ? `+${fmtUsdc(absDelta)}` : `-${fmtUsdc(absDelta)}`);
  rule();
  tag('premium', `-${fmtUsdc(ep.flatPremium)} USDC.e (debited from agent)`);
  if (refundWei > 0n) tag('refund', `+${fmtUsdc(refundWei)} USDC.e (paid from coverage pool)`);
  tag('balance', `${fmtUsdc(after.usdc)} USDC.e   Δ ${deltaStr}`);
  console.log('');

  // Talking-point line for the demo video.
  if (breachDetected) {
    const grossLoss = fmtUsdc(ep.flatPremium);
    const netLoss = delta === 0n ? '0' : `-${fmtUsdc(absDelta)}`;
    console.log(`  [insight] Without Pact: -${grossLoss} USDC.e for a call that failed its SLA.`);
    console.log(`            With Pact:    ${netLoss} USDC.e — protocol refunded you ${fmtUsdc(refundWei)}.`);
  } else {
    console.log(`  [insight] Call succeeded under SLO. Agent paid the premium, kept the result.`);
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────────
// CLI wiring
// ─────────────────────────────────────────────────────────────────────────

const cli = cac('pact-0g');
cli.help();
cli.version('0.1.0');

cli.command('balance', "agent's $0G + USDC.e + allowance to PactCore").action(cmdBalance);
cli
  .command('approve', 'agent approves PactCore to spend USDC.e (one-time)')
  .action(cmdApprove);
cli
  .command('endpoint [slug]', 'show endpoint config + lifetime stats')
  .action((slug?: string) => cmdEndpoint(slug ?? SLUG_LABEL));
cli
  .command('pool [slug]', 'show coverage pool balance for an endpoint')
  .action((slug?: string) => cmdPool(slug ?? SLUG_LABEL));
cli
  .command('pay', 'make an insured call — settled on-chain, balance shown before + after')
  .option('--breach', 'force a breach outcome so the refund flow shows')
  .option('--latency <ms>', 'simulated latency for classifier', { default: undefined })
  .action((opts: { breach?: boolean; latency?: string }) =>
    cmdPay({
      breach: opts.breach,
      latencyMs: opts.latency ? parseInt(opts.latency, 10) : undefined,
    }),
  );

cli.parse();

if (!cli.matchedCommand && !process.argv.slice(2).some((a) => a === '-h' || a === '--help')) {
  cli.outputHelp();
}

// Bare `pact-0g <url>` — Solana parity. For 0G we map any bare URL to
// `pay --breach` so a quick `pact-0g https://example.com/foo` still
// demonstrates the protocol moment.
const bareUrl = process.argv[2];
if (bareUrl && /^https?:\/\//.test(bareUrl)) {
  cmdPay({ breach: bareUrl.includes('fail') || bareUrl.includes('breach') }).catch((err) => {
    console.error('\nFAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
