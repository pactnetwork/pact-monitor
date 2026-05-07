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
 *   bun run pause -- --paused 1            # PAUSE the protocol (interactive y/N prompt)
 *   bun run pause -- --paused 1 --yes      # PAUSE the protocol, skip confirmation
 *   bun run pause -- --paused 0            # UNPAUSE the protocol (interactive y/N prompt)
 *   DRY_RUN=1 bun run pause -- --paused 1  # rehearse (no prompt; no tx sent)
 *
 * Confirmation prompt:
 *   For non-DRY_RUN runs, the script prints the destructive change clearly and
 *   waits for the operator to type `y` or `yes` on stdin before sending the tx.
 *   Anything else aborts with exit code 1. The prompt is skipped when:
 *     - `DRY_RUN=1` (no tx will be sent), OR
 *     - the operator passes `--yes` (incident-response automation).
 *
 * The script:
 *   1. Reads current `ProtocolConfig.paused` from chain (commitment=`confirmed`,
 *      cheap pre-flight check).
 *   2. No-ops cleanly if the on-chain state already matches the requested target.
 *   3. Confirms the destructive change with the operator unless skipped.
 *   4. Builds + signs `pause_protocol` (discriminator 15) with the upgrade authority.
 *   5. Sends the tx with `confirmed` commitment, then refetches the
 *      ProtocolConfig at `finalized` commitment to assert the post-tx state
 *      matches the target. `finalized` is used here so a chain reorg cannot
 *      let us walk away thinking the toggle landed when it might still be
 *      rolled back.
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
import { createInterface } from "node:readline";
import { readKeypair, resolveKeyPath } from "./lib/keys";

const KEYS_DIR = process.env.MAINNET_KEYS_DIR ?? "~/pact-mainnet-keys";
const RPC_URL = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const USAGE = `Usage: bun run pause -- --paused <0|1> [--yes]

  --paused 1   PAUSE the protocol (every settle_batch fails fast with 6032)
  --paused 0   UNPAUSE the protocol (resume normal settlement)
  --yes        Skip the interactive y/N confirmation prompt

Env:
  MAINNET_KEYS_DIR  default ~/pact-mainnet-keys
  MAINNET_RPC_URL   default https://api.mainnet-beta.solana.com
  DRY_RUN=1         skip sending; print what would happen (also skips prompt)
`;

interface ParsedArgs {
  target: 0 | 1;
  yes: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Accept --paused 1 or --paused=1, plus a boolean --yes flag (no value).
  let value: string | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--paused") {
      value = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith("--paused=")) {
      value = a.slice("--paused=".length);
      continue;
    }
    if (a === "--yes" || a === "-y") {
      yes = true;
      continue;
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
  return { target: value === "1" ? 1 : 0, yes };
}

/**
 * Prompt the operator to confirm a destructive on-chain change. Resolves to
 * true only if the operator types exactly `y` or `yes` (case-insensitive).
 * Any other input — including EOF on stdin — resolves to false.
 */
function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const a = (answer ?? "").trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

function key(name: string): string {
  return `${KEYS_DIR}/${name}`;
}

function describe(p: number): "paused" | "unpaused" {
  return p === 0 ? "unpaused" : "paused";
}

async function main() {
  const { target, yes } = parseArgs(process.argv.slice(2));

  console.log(`=== Pact Network V1 mainnet pause_protocol ===`);
  console.log(`  RPC:    ${RPC_URL}`);
  console.log(`  Keys:   ${resolveKeyPath(KEYS_DIR)}`);
  console.log(`  Mode:   ${DRY_RUN ? "DRY RUN (no tx sent)" : "REAL (tx will land on mainnet)"}`);
  console.log(`  Target: paused=${target} (${describe(target)})`);
  console.log(`  Confirm: ${DRY_RUN ? "skipped (DRY_RUN)" : yes ? "skipped (--yes)" : "interactive y/N"}\n`);

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

  // Operator confirmation. Skipped only with explicit --yes — no env var
  // override on purpose; incident automation must opt in via the flag so a
  // misset env never silently disables the prompt.
  if (!yes) {
    const promptText =
      `About to set ProtocolConfig.paused ${current} -> ${target} on mainnet ` +
      `(${RPC_URL}).\n` +
      `  ProtocolConfig: ${protocolConfigPda.toBase58()}\n` +
      `  Authority:      ${upgradeAuth.publicKey.toBase58()}\n` +
      `Type 'yes' to confirm, anything else aborts: `;
    const ok = await confirm(promptText);
    if (!ok) {
      console.error(
        "\nAborted by operator (no 'y'/'yes' confirmation). No tx sent.",
      );
      process.exit(1);
    }
    console.log("");
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

  // Verify post-tx state at `finalized` so a chain reorg (rare on Solana but
  // real) cannot let us walk away thinking the toggle landed when it might
  // still be rolled back. The pre-tx fetch above used `confirmed` because
  // it's a low-stakes read; this one is the real verification gate.
  const postAcct = await conn.getAccountInfo(protocolConfigPda, "finalized");
  if (!postAcct) {
    throw new Error(
      `Post-tx fetch returned null for ${protocolConfigPda.toBase58()}. ` +
        `Tx ${sig} may not have landed; investigate manually.`,
    );
  }
  const postCfg = decodeProtocolConfig(postAcct.data);
  const postPaused = postCfg.paused;
  console.log(`Post-tx (finalized) paused=${postPaused} (${describe(postPaused)})`);

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
