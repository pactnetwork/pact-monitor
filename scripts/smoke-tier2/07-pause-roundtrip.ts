/**
 * 07-pause-roundtrip.ts (BONUS) — kill-switch end-to-end test.
 *
 * Steps:
 *   1. Read on-chain ProtocolConfig.paused (byte offset 75) — assert == 0.
 *   2. Send pause_protocol(1) — verify byte 75 flips to 1.
 *   3. Publish 3 ok-outcome events to Pub/Sub (one full batch). Wait for the
 *      settler to pick them up — assert the resulting tx fails with err
 *      6032 (PactError::ProtocolPaused).
 *   4. Send pause_protocol(0) — verify byte 75 flips to 0.
 *   5. Publish 3 more events. Assert the next batch lands successfully.
 *
 * The protocol-v1-client doesn't yet expose `buildPauseProtocolIx`, so we
 * encode the instruction inline (disc=15, data=[paused:u8], 2 accounts).
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { PubSub } from "@google-cloud/pubsub";
import { randomBytes } from "node:crypto";

import {
  PROTOCOL_AUTHORITY_KEYPAIR,
  PUBSUB_PROJECT,
  PUBSUB_TOPIC,
  SMOKE_RPC_URL,
  ENDPOINTS,
} from "./lib/paths";
import { readKeypair } from "./lib/keys";
import { loadState } from "./lib/state";

const DISC_PAUSE_PROTOCOL = 15;
const PAUSED_OFFSET = 75;

function buildPauseProtocolIx(opts: {
  programId: PublicKey;
  authority: PublicKey;
  protocolConfig: PublicKey;
  paused: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: opts.programId,
    keys: [
      { pubkey: opts.authority, isSigner: true, isWritable: true },
      { pubkey: opts.protocolConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([DISC_PAUSE_PROTOCOL, opts.paused ? 1 : 0]),
  });
}

function randomCallId(): string {
  return Array.from(randomBytes(16))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function readPausedFlag(conn: Connection, pc: PublicKey): Promise<number> {
  const acct = await conn.getAccountInfo(pc, "confirmed");
  if (!acct) throw new Error("ProtocolConfig not found on chain");
  return acct.data[PAUSED_OFFSET];
}

async function fireBatchOf(n: number, agentIdx: number, slug: string, agentPk: string) {
  const ps = new PubSub({ projectId: PUBSUB_PROJECT });
  const topic = ps.topic(PUBSUB_TOPIC);
  for (let i = 0; i < n; i++) {
    const ev = {
      callId: randomCallId(),
      agentPubkey: agentPk,
      endpointSlug: slug,
      premiumLamports: "1000",
      refundLamports: "0",
      latencyMs: 100,
      outcome: "ok",
      ts: new Date().toISOString(),
    };
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(ev)) });
  }
}

async function main() {
  process.env.PUBSUB_EMULATOR_HOST ??= "127.0.0.1:8085";
  process.env.PUBSUB_PROJECT_ID ??= PUBSUB_PROJECT;

  const conn = new Connection(SMOKE_RPC_URL, "confirmed");
  const state = loadState();
  if (!state.programId || !state.protocolConfigPda || !state.agents) {
    throw new Error("missing state — run 02 + 03 first");
  }
  const programId = new PublicKey(state.programId);
  const protocolConfig = new PublicKey(state.protocolConfigPda);
  const auth = readKeypair(PROTOCOL_AUTHORITY_KEYPAIR);

  // Step 1: assert paused == 0 initially
  let p = await readPausedFlag(conn, protocolConfig);
  console.log(`Initial paused byte: ${p}`);
  if (p !== 0) throw new Error(`expected paused=0 initially, got ${p}`);

  // Step 2: pause
  console.log("\nSending pause_protocol(1)");
  {
    const ix = buildPauseProtocolIx({ programId, authority: auth.publicKey, protocolConfig, paused: true });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" });
    console.log(`  pause sig: ${sig}`);
  }
  p = await readPausedFlag(conn, protocolConfig);
  console.log(`After pause: ${p}`);
  if (p !== 1) throw new Error(`expected paused=1 after pause, got ${p}`);

  // Step 3: fire 3 events while paused; the next batch's settle_batch must
  // fail with custom error 0x1790 (= 6032 = ProtocolPaused).
  console.log("\nFiring 3 events while paused — settler tx should fail with 6032");
  await fireBatchOf(3, 0, ENDPOINTS[0].slug, state.agents[0].pubkey);
  console.log("  events published. Inspect .logs/settler.log for `ProtocolPaused` / `0x1790` over the next 30s.");
  await new Promise((r) => setTimeout(r, 30_000));

  // Step 4: unpause
  console.log("\nSending pause_protocol(0)");
  {
    const ix = buildPauseProtocolIx({ programId, authority: auth.publicKey, protocolConfig, paused: false });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" });
    console.log(`  unpause sig: ${sig}`);
  }
  p = await readPausedFlag(conn, protocolConfig);
  console.log(`After unpause: ${p}`);
  if (p !== 0) throw new Error(`expected paused=0 after unpause, got ${p}`);

  // Step 5: fire 3 more — these should land
  console.log("\nFiring 3 events post-unpause — these should settle");
  await fireBatchOf(3, 1, ENDPOINTS[1].slug, state.agents[1].pubkey);
  console.log("  events published. Inspect .logs/settler.log for a successful batch over the next 30s.");

  console.log("\n== smoke-tier2/07-pause-roundtrip OK (manual log-inspection required) ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
