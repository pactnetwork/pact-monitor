/**
 * topup-settler.ts — manually top up the settler's SettlementAuthority signer
 * with mainnet SOL. Defensive against pubkey drift (verifies the on-chain
 * SettlementAuthority's `signer` field matches the env / argv pubkey before
 * sending any SOL).
 *
 * NOT auto-running. Designed to be invoked from a developer laptop with the
 * funding wallet keypair on disk. The settler signer's PRIVATE key is never
 * required (and must never be passed to this script).
 *
 * Usage:
 *   pnpm tsx topup-settler.ts --amount 0.05                  # dry run
 *   pnpm tsx topup-settler.ts --amount 0.05 --confirm        # actually send
 *   pnpm tsx topup-settler.ts --amount 0.05 --confirm \
 *                              --recipient FuT7kRVwHbGgLNMULyhxU57VvDVtPMk7UqZT5DDK2ST1
 *
 * Environment:
 *   SOLANA_RPC_URL    mainnet RPC (Helius/Alchemy URL with API key, NOT
 *                     api.mainnet-beta.solana.com which 429s under any load)
 *   FUNDING_WALLET_KEY  base58 secret key OR path to a JSON keypair file. Source
 *                     of the SOL transfer. NEVER pass the SettlementAuthority
 *                     key as the funding wallet.
 *   PROGRAM_ID        defaults to mainnet program 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5
 *
 * Behavior:
 *   1. Loads the funding wallet keypair from FUNDING_WALLET_KEY.
 *   2. Resolves the on-chain SettlementAuthority PDA, decodes it, extracts
 *      the canonical `signer` pubkey. Compares against --recipient. ABORT if
 *      they disagree (catches stale runbooks before sending SOL to the wrong
 *      pubkey).
 *   3. Prints a plan: source pubkey + balance, recipient pubkey + balance,
 *      amount, expected post-balances. ABORT if the source can't cover
 *      amount + a 5000-lamport fee buffer.
 *   4. If --confirm not present: stop. If present: build and send a single
 *      SystemProgram.transfer ix; confirm; print the tx signature.
 *
 * Exit codes:
 *   0  success (or dry run completed)
 *   1  validation error (mismatched pubkey, insufficient balance, etc.)
 *   2  RPC / send error
 *
 * See docs/runbooks/settler-signer-low-sol.md for context.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  decodeSettlementAuthority,
  getSettlementAuthorityPda,
} from "@pact-network/protocol-v1-client";

const DEFAULT_PROGRAM_ID = "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";
const DEFAULT_RECIPIENT = "FuT7kRVwHbGgLNMULyhxU57VvDVtPMk7UqZT5DDK2ST1";
/** Fee buffer above the actual transfer amount that we require on the source. */
const FEE_BUFFER_LAMPORTS = 50_000;

interface CliArgs {
  amount: number; // in SOL
  confirm: boolean;
  recipient: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    amount: NaN,
    confirm: false,
    recipient: DEFAULT_RECIPIENT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--amount") {
      out.amount = Number(argv[++i]);
    } else if (a === "--confirm") {
      out.confirm = true;
    } else if (a === "--recipient") {
      out.recipient = argv[++i];
    } else if (a === "--help" || a === "-h") {
      printUsageAndExit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      printUsageAndExit(1);
    }
  }
  if (!Number.isFinite(out.amount) || out.amount <= 0) {
    console.error("--amount <SOL> is required and must be > 0");
    printUsageAndExit(1);
  }
  if (out.amount > 1) {
    console.error(
      `--amount ${out.amount} SOL exceeds 1 SOL hot-key cap (see runbook). ` +
        `If this is intentional, edit the script.`,
    );
    process.exit(1);
  }
  return out;
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage: pnpm tsx topup-settler.ts --amount <SOL> [--confirm] [--recipient <pubkey>]

Required env:
  SOLANA_RPC_URL       mainnet RPC URL with API key
  FUNDING_WALLET_KEY   base58 secret key OR path to JSON keypair

Default recipient: ${DEFAULT_RECIPIENT}
Default program:   ${DEFAULT_PROGRAM_ID}

Without --confirm: prints the plan only (dry run). With --confirm: sends.`,
  );
  process.exit(code);
}

function loadFundingKeypair(): Keypair {
  const raw = process.env.FUNDING_WALLET_KEY;
  if (!raw) {
    console.error("FUNDING_WALLET_KEY env required (base58 secret OR path to JSON keypair)");
    process.exit(1);
  }
  // Path form: a JSON array of bytes (Solana CLI keypair format).
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("~/")) {
    const path = raw.startsWith("~/")
      ? resolvePath(process.env.HOME ?? ".", raw.slice(2))
      : raw;
    const json = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(json)) {
      throw new Error(`expected JSON array at ${path}, got ${typeof json}`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(json));
  }
  // Inline base58 form.
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) {
    console.error("SOLANA_RPC_URL env required");
    process.exit(1);
  }
  const programIdStr = process.env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
  const programId = new PublicKey(programIdStr);
  const recipient = new PublicKey(args.recipient);
  const amountLamports = Math.round(args.amount * LAMPORTS_PER_SOL);

  const connection = new Connection(rpc, "confirmed");
  const funding = loadFundingKeypair();

  // ---------------------------------------------------------------------
  // Defense in depth: verify the recipient pubkey is the actual on-chain
  // SettlementAuthority signer. This catches stale runbooks / wrong-network
  // configs before SOL leaves the funding wallet.
  // ---------------------------------------------------------------------
  const [saPda] = getSettlementAuthorityPda(programId);
  console.log(`SettlementAuthority PDA: ${saPda.toBase58()}`);
  const saAccount = await connection.getAccountInfo(saPda, "confirmed");
  if (!saAccount) {
    console.error(
      `SettlementAuthority PDA ${saPda.toBase58()} not found on-chain. ` +
        `Wrong PROGRAM_ID? Wrong network? (RPC: ${rpc})`,
    );
    process.exit(1);
  }
  const sa = decodeSettlementAuthority(saAccount.data);
  const onChainSigner = new PublicKey(sa.signer);
  console.log(`On-chain SettlementAuthority.signer: ${onChainSigner.toBase58()}`);
  if (!onChainSigner.equals(recipient)) {
    console.error(
      `MISMATCH: --recipient ${recipient.toBase58()} ` +
        `does NOT match on-chain SettlementAuthority.signer ` +
        `${onChainSigner.toBase58()}.\n` +
        `  This usually means a key rotation happened and the runbook is ` +
        `stale. Refusing to send SOL to a non-signer pubkey.\n` +
        `  Re-run with --recipient ${onChainSigner.toBase58()} after ` +
        `confirming the rotation is intentional.`,
    );
    process.exit(1);
  }

  // ---------------------------------------------------------------------
  // Balance pre-flight.
  // ---------------------------------------------------------------------
  const [sourceBalance, recipientBalance] = await Promise.all([
    connection.getBalance(funding.publicKey, "confirmed"),
    connection.getBalance(recipient, "confirmed"),
  ]);

  console.log("");
  console.log("Plan:");
  console.log(`  source     = ${funding.publicKey.toBase58()}`);
  console.log(
    `  source bal = ${sourceBalance} lamports (${(sourceBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL)`,
  );
  console.log(`  recipient  = ${recipient.toBase58()}`);
  console.log(
    `  rcpt bal   = ${recipientBalance} lamports (${(recipientBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL)`,
  );
  console.log(
    `  amount     = ${amountLamports} lamports (${args.amount.toFixed(6)} SOL)`,
  );
  console.log(
    `  post-bal   = ${recipientBalance + amountLamports} lamports recipient, ${sourceBalance - amountLamports - FEE_BUFFER_LAMPORTS} lamports source (after fee buffer)`,
  );
  console.log("");

  if (sourceBalance < amountLamports + FEE_BUFFER_LAMPORTS) {
    console.error(
      `source has insufficient balance (need ≥ ${amountLamports + FEE_BUFFER_LAMPORTS} lamports for transfer + fee buffer; have ${sourceBalance})`,
    );
    process.exit(1);
  }

  if (!args.confirm) {
    console.log("DRY RUN — re-run with --confirm to send.");
    process.exit(0);
  }

  // ---------------------------------------------------------------------
  // Send.
  // ---------------------------------------------------------------------
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funding.publicKey,
      toPubkey: recipient,
      lamports: amountLamports,
    }),
  );

  console.log("sending...");
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [funding], {
      commitment: "confirmed",
    });
    console.log(`tx signature: ${sig}`);
    const newRecipientBalance = await connection.getBalance(
      recipient,
      "confirmed",
    );
    console.log(
      `post-tx recipient balance: ${newRecipientBalance} lamports (${(newRecipientBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL)`,
    );
  } catch (err) {
    console.error(`send failed: ${(err as Error).message ?? err}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
