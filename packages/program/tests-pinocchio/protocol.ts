// WP-5 migration target: the two `initialize_protocol` tests from
// `tests/protocol.ts`, rewritten against the Codama builder + `@solana/kit`.
// Runs against `solana-test-validator` pre-loaded with the Pinocchio `.so`.
//
// Run with:
//   pnpm tsx tests-pinocchio/protocol.ts
//
// The harness spawns its own validator on a random port + temp ledger. No
// external services are required beyond `solana-test-validator` being on
// `$PATH` (Agave install). The Anchor test suite is independent and still
// uses `anchor test`.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  appendTransactionMessageInstruction,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  getInitializeProtocolInstruction,
  findProtocolConfigPda,
  decodeProtocolConfig,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Validator harness
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = resolve(__dirname, '..');
const PINOCCHIO_SO = resolve(
  PROGRAM_ROOT,
  'target/deploy/pact_insurance_pinocchio.so',
);

const RPC_PORT = 8899 + Math.floor(Math.random() * 1000);
const FAUCET_PORT = RPC_PORT + 1;

// Kit's `createSolanaRpc` returns a cluster-branded RPC union; localhost is
// not one of the tagged clusters, and the testnet-only methods we need
// (`requestAirdrop`) get pruned from the inferred type. For a test harness
// the pragmatic fix is to widen to `any` at the boundary.
interface Harness {
  proc: ChildProcess;
  ledger: string;
  rpc: any;
  rpcSubscriptions: any;
}

async function startValidator(): Promise<Harness> {
  if (!existsSync(PINOCCHIO_SO)) {
    throw new Error(
      `Pinocchio .so not found at ${PINOCCHIO_SO}. Run:\n  cargo build-sbf --manifest-path programs-pinocchio/pact-insurance-pinocchio/Cargo.toml --features bpf-entrypoint`,
    );
  }

  const ledger = await mkdtemp(resolve(tmpdir(), 'pact-pino-ledger-'));
  const proc = spawn(
    'solana-test-validator',
    [
      '--ledger',
      ledger,
      '--reset',
      '--quiet',
      '--rpc-port',
      String(RPC_PORT),
      '--faucet-port',
      String(FAUCET_PORT),
      '--bpf-program',
      PACT_INSURANCE_PROGRAM_ADDRESS,
      PINOCCHIO_SO,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  proc.on('error', (err) => {
    console.error('validator spawn error:', err);
  });

  const rpc = createSolanaRpc(`http://127.0.0.1:${RPC_PORT}`);
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    `ws://127.0.0.1:${RPC_PORT + 1}`,
  );

  // Poll until getHealth succeeds.
  const started = Date.now();
  const timeoutMs = 60_000;
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await rpc.getHealth().send();
      if (health === 'ok') break;
    } catch (_) {
      // validator not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return { proc, ledger, rpc, rpcSubscriptions };
}

async function stopValidator(h: Harness): Promise<void> {
  h.proc.kill('SIGTERM');
  await new Promise<void>((resolveWait) => {
    h.proc.once('exit', () => resolveWait());
    setTimeout(() => {
      if (!h.proc.killed) h.proc.kill('SIGKILL');
      resolveWait();
    }, 5000);
  });
  await rm(h.ledger, { recursive: true, force: true });
}

async function waitForSignature(
  h: Harness,
  sig: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value: statuses } = await h.rpc
      .getSignatureStatuses([sig as any])
      .send();
    const status = statuses[0];
    if (status) {
      if (status.err) {
        throw new Error(
          `transaction ${sig} failed: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`transaction ${sig} not confirmed within ${timeoutMs}ms`);
}

async function fundedSigner(h: Harness, sol = 10): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  const sig = await h.rpc
    .requestAirdrop(signer.address, BigInt(sol * 1_000_000_000) as any)
    .send();
  await waitForSignature(h, sig);
  return signer;
}

async function sendInitialize(
  h: Harness,
  deployer: KeyPairSigner,
  config: Address,
  args: {
    authority: Address;
    oracle: Address;
    treasury: Address;
    usdcMint: Address;
  },
): Promise<void> {
  const ix = getInitializeProtocolInstruction({
    config,
    deployer,
    args,
  });
  const { value: latest } = await h.rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deployer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await h.rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  await waitForSignature(h, sig);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('[wp5] starting validator...');
  const h = await startValidator();
  let failures = 0;
  try {
    const [protocolPda] = await findProtocolConfigPda();
    const deployer = await fundedSigner(h, 10);
    const authority = (await generateKeyPairSigner()).address;
    const oracle = (await generateKeyPairSigner()).address;
    const treasury = (await generateKeyPairSigner()).address;
    const usdcMint = (await generateKeyPairSigner()).address;

    // Test 1 — initializes the protocol config with a separate authority and oracle
    try {
      await sendInitialize(h, deployer, protocolPda, {
        authority,
        oracle,
        treasury,
        usdcMint,
      });

      const { value: acct } = await h.rpc
        .getAccountInfo(protocolPda, { encoding: 'base64' })
        .send();
      assert(acct, 'protocol config account should exist');
      const raw = Buffer.from(acct.data[0], 'base64');
      const cfg = decodeProtocolConfig(new Uint8Array(raw));

      assert.equal(cfg.discriminator, 0);
      assert.equal(cfg.authority, authority);
      assert.equal(cfg.oracle, oracle);
      assert.equal(cfg.treasury, treasury);
      assert.equal(cfg.usdcMint, usdcMint);
      assert.notEqual(cfg.authority, deployer.address);
      assert.notEqual(cfg.authority, cfg.oracle);
      assert.equal(cfg.protocolFeeBps, 1500);
      assert.equal(cfg.minPoolDeposit, 100_000_000n);
      assert.equal(cfg.withdrawalCooldownSeconds, 604_800n);
      assert.equal(cfg.aggregateCapBps, 3000);
      assert.equal(cfg.aggregateCapWindowSeconds, 86_400n);
      assert.equal(cfg.paused, 0);
      console.log('[wp5] PASS: initializes the protocol config with a separate authority and oracle');
    } catch (err) {
      failures++;
      console.error('[wp5] FAIL: initialize test —', err);
    }

    // Test 2 — rejects second initialization (PDA already exists)
    try {
      let threw = false;
      try {
        await sendInitialize(h, deployer, protocolPda, {
          authority,
          oracle,
          treasury,
          usdcMint,
        });
      } catch (err) {
        threw = true;
        // The kit SolanaError can shape the preflight detail under a context
        // object (`err.context.preflightErrorMessage`) or fold it into the
        // message. Walk both surfaces so we match Anchor-style
        // `already in use`, our own `AccountAlreadyInitialized`, or the
        // runtime's `custom program error: 0x0` forms.
        const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.match(
          detail,
          /already in use|AccountAlreadyInitialized|already initialized|0x0|custom program error|requires an uninitialized account/i,
          `second init should surface account-already-in-use, got: ${detail}`,
        );
      }
      assert(threw, 'second init must reject');
      console.log('[wp5] PASS: rejects second initialization (PDA already exists)');
    } catch (err) {
      failures++;
      console.error('[wp5] FAIL: reject-second-init test —', err);
    }
  } finally {
    console.log('[wp5] stopping validator...');
    await stopValidator(h);
  }

  if (failures > 0) {
    console.error(`[wp5] ${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('[wp5] all migrated tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
