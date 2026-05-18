/**
 * fund-agent.ts — provision a devnet agent for the live SDK E2E.
 *
 * What this self-serves (no repo secrets needed):
 *   1. Airdrops devnet SOL to the agent (rent + tx fees), rate-limit aware.
 *   2. Derives the agent's devnet USDC associated token account (ATA).
 *   3. Once the ATA holds >= the requested allowance, sends a real SPL Token
 *      `Approve` so the SettlementAuthority PDA is the ATA's delegate — the
 *      exact on-chain act `pact.setup()` performs, done here so the E2E can
 *      assert against a pre-provisioned agent.
 *
 * The ONE true external dependency (honest callout): devnet USDC
 * `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` is hardcoded by the on-chain
 * program and is NOT faucet-able; the surfpool `surfnet_setTokenAccount`
 * cheatcode used by scripts/smoke-tier2 only exists on localnet/surfpool.
 * Minting/transferring it on public devnet requires that mint's authority,
 * which is not in this repo. This script prints the exact one-line command
 * for whoever holds it, then polls until the ATA is funded — reducing the
 * external touch to a single copy-pasteable command, not tribal ops.
 *
 * Usage:
 *   pnpm tsx fund-agent.ts --secret-key <bs58-64-byte> [--allowance-usdc 5]
 *                          [--program-id <id>] [--rpc URL] [--no-wait]
 *
 * Env fallbacks: PACT_DEVNET_SECRET_KEY, PACT_DEVNET_PROGRAM_ID, SOLANA_RPC_URL.
 *
 * Exit codes: 0 funded + approved (or printed-and-exited with --no-wait) ·
 *             1 validation / not funded within the wait window · 2 RPC error
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  buildApproveIx,
  deriveAssociatedTokenAccount,
  getSettlementAuthorityPda,
  PROGRAM_ID_DEVNET,
  USDC_MINT_DEVNET,
} from "@pact-network/protocol-v1-client";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const USDC_DECIMALS = 1_000_000; // devnet USDC has 6 decimals
const MIN_SOL_LAMPORTS = 0.5 * 1e9;
const AIRDROP_LAMPORTS = 1 * 1e9;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

interface CliArgs {
  secretKey: string;
  programId: string;
  allowanceUsdc: number;
  rpc: string;
  wait: boolean;
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage: pnpm tsx fund-agent.ts --secret-key <bs58-64-byte> [--allowance-usdc 5] [--program-id <id>] [--rpc URL] [--no-wait]

Env fallbacks: PACT_DEVNET_SECRET_KEY, PACT_DEVNET_PROGRAM_ID,
               SOLANA_RPC_URL (default ${DEFAULT_RPC})`,
  );
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    secretKey: process.env.PACT_DEVNET_SECRET_KEY ?? "",
    programId: process.env.PACT_DEVNET_PROGRAM_ID ?? PROGRAM_ID_DEVNET.toBase58(),
    allowanceUsdc: 5,
    rpc: process.env.SOLANA_RPC_URL ?? DEFAULT_RPC,
    wait: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--secret-key") out.secretKey = argv[++i] ?? "";
    else if (a === "--program-id") out.programId = argv[++i] ?? "";
    else if (a === "--allowance-usdc") out.allowanceUsdc = Number(argv[++i]);
    else if (a === "--rpc") out.rpc = argv[++i] ?? "";
    else if (a === "--no-wait") out.wait = false;
    else if (a === "--help" || a === "-h") printUsageAndExit(0);
    else {
      console.error(`unknown argument: ${a}`);
      printUsageAndExit(2);
    }
  }
  if (!out.secretKey) {
    console.error("--secret-key (or PACT_DEVNET_SECRET_KEY) is required");
    printUsageAndExit(2);
  }
  if (!Number.isFinite(out.allowanceUsdc) || out.allowanceUsdc <= 0) {
    console.error("--allowance-usdc must be a positive number");
    printUsageAndExit(2);
  }
  return out;
}

function loadAgent(secretKey: string): Keypair {
  try {
    return Keypair.fromSecretKey(bs58.decode(secretKey));
  } catch (err) {
    console.error(`invalid --secret-key (expected bs58 64-byte): ${(err as Error).message}`);
    process.exit(2);
  }
}

async function ensureSol(conn: Connection, agent: PublicKey): Promise<void> {
  const bal = await conn.getBalance(agent, "confirmed");
  if (bal >= MIN_SOL_LAMPORTS) {
    console.log(`SOL balance ok: ${(bal / 1e9).toFixed(4)} SOL`);
    return;
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      console.log(`requesting devnet airdrop (attempt ${attempt})...`);
      const sig = await conn.requestAirdrop(agent, AIRDROP_LAMPORTS);
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`airdrop confirmed: ${sig}`);
      return;
    } catch (err) {
      console.warn(`airdrop attempt ${attempt} failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, attempt * 3_000));
    }
  }
  console.error(
    "devnet airdrop exhausted (rate-limited). Fund the agent SOL manually:\n" +
      `  solana airdrop 1 ${agent.toBase58()} --url devnet`,
  );
  process.exit(1);
}

async function ataBalanceLamports(conn: Connection, ata: PublicKey): Promise<bigint | null> {
  try {
    const b = await conn.getTokenAccountBalance(ata, "confirmed");
    return BigInt(b.value.amount);
  } catch {
    return null; // ATA does not exist yet
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const agent = loadAgent(args.secretKey);
  let programId: PublicKey;
  try {
    programId = new PublicKey(args.programId);
  } catch {
    console.error(`invalid --program-id: ${args.programId}`);
    process.exit(2);
  }

  const conn = new Connection(args.rpc, "confirmed");
  const ata = deriveAssociatedTokenAccount(agent.publicKey, USDC_MINT_DEVNET);
  const [saPda] = getSettlementAuthorityPda(programId);
  const allowanceLamports = BigInt(Math.round(args.allowanceUsdc * USDC_DECIMALS));

  console.log("");
  console.log(`agent           = ${agent.publicKey.toBase58()}`);
  console.log(`program         = ${programId.toBase58()}`);
  console.log(`devnet USDC ATA = ${ata.toBase58()}`);
  console.log(`SettlementAuth  = ${saPda.toBase58()}  (delegate to Approve)`);
  console.log(`allowance       = ${args.allowanceUsdc} USDC (${allowanceLamports} lamports)`);
  console.log("");

  await ensureSol(conn, agent.publicKey);

  let bal = await ataBalanceLamports(conn, ata);
  if (bal === null || bal < allowanceLamports) {
    console.log("");
    console.log("EXTERNAL STEP REQUIRED — devnet USDC is not faucet-able.");
    console.log("Whoever holds the devnet USDC mint authority (or a treasury");
    console.log(`holding ${USDC_MINT_DEVNET.toBase58()}) runs ONE of:`);
    console.log("");
    console.log(`  # mint authority path (creates + funds the ATA):`);
    console.log(
      `  spl-token mint ${USDC_MINT_DEVNET.toBase58()} ${args.allowanceUsdc} \\\n` +
        `    --recipient-owner ${agent.publicKey.toBase58()} --url devnet --fund-recipient`,
    );
    console.log("");
    console.log(`  # treasury-transfer path:`);
    console.log(
      `  spl-token transfer ${USDC_MINT_DEVNET.toBase58()} ${args.allowanceUsdc} \\\n` +
        `    ${agent.publicKey.toBase58()} --url devnet --fund-recipient --allow-unfunded-recipient`,
    );
    console.log("");
    if (!args.wait) {
      console.log("--no-wait set: printed the command and exiting. Re-run without");
      console.log("--no-wait (or with the ATA already funded) to send the Approve.");
      process.exit(0);
    }
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    process.stdout.write("waiting for the ATA to be funded");
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      process.stdout.write(".");
      bal = await ataBalanceLamports(conn, ata);
      if (bal !== null && bal >= allowanceLamports) {
        console.log("\nATA funded.");
        break;
      }
    }
    if (bal === null || bal < allowanceLamports) {
      console.error(
        `\nATA still under ${allowanceLamports} lamports after ` +
          `${POLL_TIMEOUT_MS / 60_000} min. Aborting (no Approve sent).`,
      );
      process.exit(1);
    }
  } else {
    console.log(`ATA already holds ${bal} lamports (>= allowance).`);
  }

  console.log("sending SPL Token Approve (SettlementAuthority as delegate)...");
  try {
    const approveIx = buildApproveIx({
      agentAta: ata,
      settlementAuthorityPda: saPda,
      allowanceLamports,
      agentOwner: agent.publicKey,
    });
    const tx = new Transaction().add(approveIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [agent], {
      commitment: "confirmed",
    });
    console.log(`Approve tx: ${sig}`);
    console.log("\nagent provisioned. Run the live E2E with:");
    console.log(
      `  PACT_SDK_E2E=1 PACT_DEVNET_PROGRAM_ID=${programId.toBase58()} \\\n` +
        `  PACT_DEVNET_SECRET_KEY=<bs58> PACT_DEVNET_INDEXER_URL=https://indexer.pactnetwork.io \\\n` +
        `  pnpm --filter @pact-network/sdk test:e2e`,
    );
  } catch (err) {
    console.error(`Approve failed: ${(err as Error).message ?? err}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
