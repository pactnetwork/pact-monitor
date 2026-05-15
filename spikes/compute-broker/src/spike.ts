/**
 * Spike 2 — 0G Compute broker round-trip.
 *
 * Proves the path Pact-0G's market-proxy will take per insured inference call:
 *   1. broker = createZGComputeNetworkBroker(wallet)
 *   2. broker.ledger.depositFund(N)              // ≥3 0G first time
 *   3. broker.inference.listService()            // discover providers
 *   4. broker.inference.getServiceMetadata(p)    // → { endpoint, model }
 *   5. broker.inference.getRequestHeaders(p)     // signed auth headers
 *   6. fetch(`${endpoint}/chat/completions`, …)  // OpenAI-shaped POST
 *   7. broker.inference.processResponse(p, id)   // optional TEE verify
 *
 * If any of these fails, the plan changes shape.
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

const RPC_URL         = required('RPC_URL');
const PRIVATE_KEY     = required('PRIVATE_KEY');
const PINNED_PROVIDER = process.env.PROVIDER_ADDRESS?.trim() || undefined;
const DEPOSIT_OG      = Number(process.env.DEPOSIT_OG ?? '3');

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('0x000000000')) {
    throw new Error(`set ${name} in .env (current: ${v ?? 'undefined'})`);
  }
  return v;
}

async function main() {
  console.log('=== 0G Compute broker spike ===');
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('wallet address:', await wallet.getAddress());

  const net      = await provider.getNetwork();
  console.log('chain id:', net.chainId.toString());
  if (net.chainId !== 16602n && net.chainId !== 16661n) {
    console.warn('  not on 0G (testnet=16602, mainnet=16661). Continuing — verify RPC_URL.');
  } else {
    console.log('  network:', net.chainId === 16602n ? 'Galileo testnet' : 'Aristotle mainnet');
  }

  console.log('\n--- step 1: create broker');
  const broker = await createZGComputeNetworkBroker(wallet);
  console.log('broker created');

  console.log('\n--- step 2: deposit');
  try {
    await broker.ledger.depositFund(DEPOSIT_OG);
    console.log(`deposited ${DEPOSIT_OG} 0G`);
  } catch (err) {
    console.log('deposit failed (already funded?):', (err as Error).message);
  }

  console.log('\n--- step 3: listService');
  const services = await broker.inference.listService();
  const chatbots = services.filter((s: any) => s.serviceType === 'chatbot');
  console.log(`found ${services.length} services, ${chatbots.length} chatbots`);
  for (const s of chatbots.slice(0, 5)) {
    console.log(`  provider=${s.provider} model=${s.model ?? '?'}`);
  }

  const target = PINNED_PROVIDER ?? chatbots[0]?.provider;
  if (!target) throw new Error('no chatbot service found');
  console.log('targeting provider:', target);

  console.log('\n--- step 4: getServiceMetadata');
  const meta = await broker.inference.getServiceMetadata(target);
  console.log('endpoint:', meta.endpoint);
  console.log('model:',    meta.model);

  console.log('\n--- step 5: getRequestHeaders');
  const headers = await broker.inference.getRequestHeaders(target);
  console.log('headers keys:', Object.keys(headers));

  console.log('\n--- step 6: POST /chat/completions');
  const t0 = Date.now();
  const res = await fetch(`${meta.endpoint}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify({
      model:    meta.model,
      messages: [{ role: 'user', content: 'say "pact-0g ok" and nothing else' }],
    }),
  });
  const latencyMs = Date.now() - t0;
  console.log(`status=${res.status} latency=${latencyMs}ms`);
  const body = await res.json();
  console.log('reply:', body?.choices?.[0]?.message?.content);

  const chatId = res.headers.get('ZG-Res-Key') || body?.id;
  if (!chatId) {
    console.log('no ZG-Res-Key header or id — TEE verify not possible');
  } else {
    console.log('\n--- step 7: processResponse');
    try {
      const ok = await broker.inference.processResponse(target, chatId);
      console.log('TEE verify:', ok);
    } catch (err) {
      console.log('processResponse failed:', (err as Error).message);
    }
  }

  console.log('\n=== spike done ===');
}

main().catch((err) => {
  console.error('\n!!! spike failed');
  console.error(err);
  process.exit(1);
});
