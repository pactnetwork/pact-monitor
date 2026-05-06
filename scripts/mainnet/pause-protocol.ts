/**
 * pause-protocol.ts — V1 mainnet kill switch.
 *
 * Toggles `ProtocolConfig.paused` on the live mainnet program. When
 * `paused != 0` every subsequent `settle_batch` returns
 * `PactError::ProtocolPaused (6032)` before any per-event work runs, halting
 * the entire settlement pipeline. Operators flip this only in an incident.
 *
 * RUN FROM RICK'S LAPTOP. The upgrade-authority keypair NEVER touches the dev VM.
 *
 * Pre-flight:
 *   - `pact-mainnet-upgrade-authority.json` and `pact-network-v1-program-keypair.json`
 *     present in $MAINNET_KEYS_DIR (default: ~/pact-mainnet-keys).
 *   - Program already deployed and `initialize_protocol_config` already ran
 *     (otherwise the ProtocolConfig PDA does not exist and this script aborts).
 *   - Upgrade authority funded with a small amount of mainnet SOL (one tx fee).
 *
 * Env (with defaults):
 *   MAINNET_KEYS_DIR=~/pact-mainnet-keys
 *   MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
 *   DRY_RUN=1       (skip sending; print what would happen)
 *
 * Usage:
 *   cd scripts/mainnet
 *   bun install
 *   bun run pause -- --paused 1     # PAUSE the protocol
 *   bun run pause -- --paused 0     # UNPAUSE the protocol
 *   DRY_RUN=1 bun run pause -- --paused 1   # rehearse
 *
 * The script:
 *   1. Reads current `ProtocolConfig.paused` from chain.
 *   2. No-ops cleanly if the on-chain state already matches the requested target.
 *   3. Builds + signs `pause_protocol` (discriminator 15) with the upgrade authority.
 *   4. Sends the tx, then refetches and asserts the post-tx state matches the target.
 */
import {
  Connection,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  buildPauseProtocolIx,
  decodeProtocolConfig,
  getProtocolConfigPda,
} from "@pact-network/protocol-v1-client";
import { readKeypair, resolveKeyPath } from "./lib/keys";

const KEYS_DIR = process.env.MAINNET_KEYS_DIR ?? "~/pact-mainnet-keys";
const RPC_URL = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const USAGE = `Usage: bun run pause -- --paused <0|1>

  --paused 1   PAUSE the protocol (every settle_batch fails fast with 6032)
  --paused 0   UNPAUSE the protocol (resume normal settlement)

Env:
  MAINNET_KEYS_DIR  default ~/pact-mainnet-keys
  MAINNET_RPC_URL   default https://api.mainnet-beta.solana.com
  DRY_RUN=1         skip sending; print what would happen
`;

function parseTarget(argv: string[]): 0 | 1 {
  // Accept --paused 1 or --paused=1.
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--paused") {
      value = argv[i + 1];
      break;
    }
    if (a.startsWith("--paused=")) {
      value = a.slice("--paused=".length);
      break;
    }
  }
  if (value === undefined) {
    throw new Error(`Missing required flag --paused.\n\n${USAGE}`);
  }
  if (value !== "0" && value !== "1") {
    throw new Error(
      `Invalid --paused value "${value}". Must be exactly 0 or 1.\n\n${USAGE}`,
    );
  }
  return value === "1" ? 1 : 0;
}

function key(name: string): string {
  return `${KEYS_DIR}/${name}`;
}

function describe(p: number): "paused" | "unpaused" {
  return p === 0 ? "unpaused" : "paused";
}

async function main() {
  const target = parseTarget(process.argv.slice(2));

  console.log(`=== Pact Network V1 mainnet pause_protocol ===`);
  console.log(`  RPC:    ${RPC_URL}`);
  console.log(`  Keys:   ${resolveKeyPath(KEYS_DIR)}`);
  console.log(`  Mode:   ${DRY_RUN ? "DRY RUN (no tx sent)" : "REAL (tx will land on mainnet)"}`);
  console.log(`  Target: paused=${target} (${describe(target)})\n`);

  // Load keypairs up front so a missing file fails fast.
  const programKp = readKeypair(key("pact-network-v1-program-keypair.json"));
  const upgradeAuth = readKeypair(key("pact-mainnet-upgrade-authority.json"));

  const programId = programKp.publicKey;
  console.log(`Program ID:        ${programId.toBase58()}`);
  console.log(`Upgrade authority: ${upgradeAuth.publicKey.toBase58()}\n`);

  const conn = new Connection(RPC_URL, "confirmed");

  // Pre-flight: confirm program is actually deployed at the expected address.
  const progAcct = await conn.getAccountInfo(programId, "confirmed");
  if (!progAcct || progAcct.data.length === 0) {
    throw new Error(
      `Program ${programId.toBase58()} not found (or empty) on ${RPC_URL}.\n` +
        `Cannot pause a program that has not been deployed.`,
    );
  }
  console.log(
    `  program account exists, ${progAcct.data.length} bytes, owner ${progAcct.owner.toBase58()}\n`,
  );

  // Read current ProtocolConfig.paused.
  const [protocolConfigPda] = getProtocolConfigPda(programId);
  console.log(`ProtocolConfig PDA: ${protocolConfigPda.toBase58()}`);

  const cfgAcct = await conn.getAccountInfo(protocolConfigPda, "confirmed");
  if (!cfgAcct) {
    throw new Error(
      `ProtocolConfig ${protocolConfigPda.toBase58()} not found.\n` +
        `Run scripts/mainnet/init-mainnet.ts first.`,
    );
  }
  const cfg = decodeProtocolConfig(cfgAcct.data);
  const current = cfg.paused;
  console.log(`  authority on-chain: ${cfg.authority}`);
  console.log(`  current paused=${current} (${describe(current)})\n`);

  // Sanity check: only the on-chain authority can succeed; warn loudly if
  // the configured upgrade-authority keypair doesn't match.
  if (cfg.authority !== upgradeAuth.publicKey.toBase58()) {
    throw new Error(
      `Authority mismatch:\n` +
        `  ProtocolConfig.authority on chain: ${cfg.authority}\n` +
        `  upgrade-authority keypair pubkey:  ${upgradeAuth.publicKey.toBase58()}\n` +
        `pause_protocol will reject any signer other than the on-chain authority.`,
    );
  }

  // No-op fast path.
  const targetState = target === 1 ? "paused" : "unpaused";
  if ((current === 0 && target === 0) || (current !== 0 && target === 1)) {
    console.log(`no-op, already ${targetState}. Exiting.`);
    return;
  }

  if (DRY_RUN) {
    console.log(
      `[DRY_RUN] would build pause_protocol(paused=${target}) signed by ` +
        `${upgradeAuth.publicKey.toBase58()} and send to ${RPC_URL}.`,
    );
    console.log(`[DRY_RUN] no transaction sent.`);
    return;
  }

  // Build + send the tx.
  const ix = buildPauseProtocolIx({
    programId,
    authority: upgradeAuth.publicKey,
    paused: target === 1,
  });
  const tx = new Transaction().add(ix);
  console.log(`Sending pause_protocol(paused=${target}) ...`);
  const sig = await sendAndConfirmTransaction(conn, tx, [upgradeAuth], {
    commitment: "confirmed",
  });
  console.log(`  sig: ${sig}\n`);

  // Verify post-tx state.
  const postAcct = await conn.getAccountInfo(protocolConfigPda, "confirmed");
  if (!postAcct) {
    throw new Error(
      `Post-tx fetch returned null for ${protocolConfigPda.toBase58()}. ` +
        `Tx ${sig} may not have landed; investigate manually.`,
    );
  }
  const postCfg = decodeProtocolConfig(postAcct.data);
  const postPaused = postCfg.paused;
  console.log(`Post-tx paused=${postPaused} (${describe(postPaused)})`);

  const expectedNonZero = target === 1;
  const actualNonZero = postPaused !== 0;
  if (expectedNonZero !== actualNonZero) {
    throw new Error(
      `Post-tx state mismatch: expected paused=${target}, got ${postPaused}. ` +
        `Tx sig ${sig}. Investigate before retrying.`,
    );
  }

  console.log(
    `\n=== pause_protocol COMPLETE: protocol is now ${describe(postPaused)} ===`,
  );
  console.log(`Tx signature: ${sig}`);
  console.log(
    `Verify: solana account ${protocolConfigPda.toBase58()} --url ${RPC_URL}`,
  );
}

main().catch((e) => {
  console.error("\nPAUSE FAILED:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
