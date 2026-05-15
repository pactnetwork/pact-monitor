/**
 * Spike 3 — 0G Storage upload + download round-trip.
 *
 * Proves the path Pact-0G's settler will take per settlement:
 *   1. MemData(blob) → upload via Indexer → { rootHash, txHash }
 *   2. download(rootHash) → original bytes
 *
 * Also validates determinism: hashing the same blob twice yields the same
 * rootHash, which is what makes the orphan-blob retry strategy idempotent.
 */

import 'dotenv/config';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { MemData, Indexer } from '@0gfoundation/0g-storage-ts-sdk';

const RPC_URL     = required('RPC_URL');
const INDEXER_URL = required('INDEXER_URL');
const PRIVATE_KEY = required('PRIVATE_KEY');

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('0x000000000')) {
    throw new Error(`set ${name} in .env (current: ${v ?? 'undefined'})`);
  }
  return v;
}

async function main() {
  console.log('=== 0G Storage spike ===');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('wallet address:', await signer.getAddress());

  const net = await provider.getNetwork();
  console.log('chain id:', net.chainId.toString());
  if (net.chainId !== 16602n && net.chainId !== 16661n) {
    console.warn('  not on 0G (testnet=16602, mainnet=16661). Continuing — verify RPC_URL.');
  } else {
    console.log('  network:', net.chainId === 16602n ? 'Galileo testnet' : 'Aristotle mainnet');
  }

  const indexer = new Indexer(INDEXER_URL);

  // canonical Pact-0G evidence blob shape — exactly what settler will write
  const callId    = randomUUID();
  const evidence  = {
    callId,
    slug:               'spike',
    agent:              await signer.getAddress(),
    request_hash:       '0x' + 'a'.repeat(64),
    latency_ms:         123,
    status_code:        200,
    classifier_verdict: 'settled',
    headers:            { 'x-pact-trace': 'spike' },
    ts:                 new Date().toISOString(),
  };
  const blob = new TextEncoder().encode(JSON.stringify(evidence));
  console.log('blob bytes:', blob.byteLength);

  console.log('\n--- step 1: build MemData + merkleTree (determinism check)');
  const memA = new MemData(blob);
  const [treeA, errA] = await memA.merkleTree();
  if (errA) throw new Error(`merkleTree A error: ${errA}`);
  const rootA = treeA!.rootHash();
  console.log('rootHash (A):', rootA);

  const memB = new MemData(blob);
  const [treeB, errB] = await memB.merkleTree();
  if (errB) throw new Error(`merkleTree B error: ${errB}`);
  const rootB = treeB!.rootHash();
  console.log('rootHash (B):', rootB);
  if (rootA !== rootB) {
    throw new Error('non-deterministic rootHash — settler orphan-retry strategy breaks');
  }
  console.log('determinism: OK');

  console.log('\n--- step 2: upload');
  const t0 = Date.now();
  const [uploadTx, uploadErr] = await indexer.upload(memA, RPC_URL, signer);
  const uploadMs = Date.now() - t0;
  if (uploadErr) throw new Error(`upload error: ${uploadErr}`);
  console.log(`upload tx: ${uploadTx} (${uploadMs}ms)`);

  console.log('\n--- step 3: download');
  const outPath = join(tmpdir(), `0g-spike-${callId}.json`);
  const t1 = Date.now();
  const dlErr = await indexer.download(rootA, outPath, true);
  const dlMs = Date.now() - t1;
  if (dlErr) throw new Error(`download error: ${dlErr}`);
  console.log(`downloaded to ${outPath} (${dlMs}ms)`);

  const roundtrip = await readFile(outPath, 'utf8');
  const parsed    = JSON.parse(roundtrip);
  if (parsed.callId !== callId) {
    throw new Error('round-trip mismatch — got: ' + JSON.stringify(parsed));
  }
  console.log('round-trip: OK');
  await unlink(outPath);

  console.log('\n=== spike done ===');
  console.log({
    rootHash:    rootA,
    uploadTx,
    blobBytes:   blob.byteLength,
    uploadMs,
    downloadMs:  dlMs,
  });
}

main().catch((err) => {
  console.error('\n!!! spike failed');
  console.error(err);
  process.exit(1);
});
