/**
 * register-endpoint-onchain — ops-only script that submits the on-chain
 * `register_endpoint` instruction for `merchant_endpoints` rows that are
 * still in `pending_review`.
 *
 * Why this is a script and not an API route: `register_endpoint` requires
 * the protocol authority as a signer. Keeping that key OUT of the public
 * Fastify process is the whole point — only the ops box runs this.
 *
 * Runbook
 * -------
 *   PACT_AUTHORITY_KEYPAIR=/path/to/keypair.json \
 *   PACT_RPC_URL=https://api.devnet.solana.com \
 *   PACT_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
 *   DATABASE_URL=postgres://... \
 *   pnpm --filter @pact-network/backend register-endpoint-onchain -- \
 *     --all-pending
 *
 * Flags:
 *   --all-pending                      process every pending_review row
 *   --merchant-endpoint-id <uuid>      target a specific row
 *   --dry-run                          build + log the unsigned instruction;
 *                                       no submit; no DB update
 *
 * Notes:
 * - Slug is derived from the merchant_endpoints UUID: 16 bytes of the
 *   row id with dashes stripped, hex-decoded. UUIDs are 16 raw bytes, so
 *   each registration gets a guaranteed-unique 16-byte slug with zero
 *   collision risk across the whole table.
 * - poolVault is a fresh Keypair: SystemProgram.createAccount allocates
 *   165 bytes owned by the SPL Token program, then register_endpoint
 *   itself calls InitializeAccount3 against the pool PDA.
 * - When ProtocolConfig.default_fee_recipients contains AffiliateAta
 *   entries, we derive their ATAs via getAssociatedTokenAddress. The
 *   builder requires them in the SAME ORDER as the AffiliateAta entries
 *   appear in default_fee_recipients (codex 2026-05-05 review).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  PROGRAM_ID,
  buildRegisterEndpointIx,
  decodeProtocolConfig,
  FeeRecipientKind,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getTreasuryPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { query, getMany, pool } from "../db.js";

interface PendingRow {
  id: string;
  merchant_pubkey: string;
  hostname: string;
  endpoint_path: string;
  amount_usd: string; // numeric — pg returns as string
  preferred_rate_bps: number;
  status: string;
}

interface CliArgs {
  allPending: boolean;
  id?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { allPending: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all-pending") out.allPending = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--merchant-endpoint-id") {
      const v = argv[++i];
      if (!v) throw new Error("--merchant-endpoint-id needs a UUID");
      out.id = v;
    }
  }
  if (!out.allPending && !out.id) {
    throw new Error(
      "specify --all-pending OR --merchant-endpoint-id <uuid>",
    );
  }
  return out;
}

function loadAuthorityKeypair(): Keypair {
  const raw = process.env.PACT_AUTHORITY_KEYPAIR;
  if (!raw) throw new Error("PACT_AUTHORITY_KEYPAIR env var is required");
  // Accept either a JSON-encoded array (e.g. solana-keygen output) or a
  // path to such a file.
  let secret: number[];
  if (raw.trim().startsWith("[")) {
    secret = JSON.parse(raw);
  } else {
    secret = JSON.parse(readFileSync(raw, "utf-8"));
  }
  if (!Array.isArray(secret) || secret.length !== 64) {
    throw new Error(
      "PACT_AUTHORITY_KEYPAIR must decode to a 64-byte secret-key array",
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Derive a 16-byte slug from the merchant_endpoints UUID. */
function slugFromUuid(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`expected 32-char hex UUID, got ${hex.length}: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function fetchAffiliateAtas(
  connection: Connection,
  protocolConfigPda: PublicKey,
  usdcMint: PublicKey,
): Promise<PublicKey[]> {
  const info = await connection.getAccountInfo(protocolConfigPda);
  if (!info) {
    throw new Error(
      `ProtocolConfig ${protocolConfigPda.toBase58()} not found on this RPC`,
    );
  }
  const decoded = decodeProtocolConfig(info.data);
  const atas: PublicKey[] = [];
  for (const fr of decoded.defaultFeeRecipients) {
    if (fr.kind === FeeRecipientKind.AffiliateAta) {
      const owner = new PublicKey(fr.destination);
      const ata = await getAssociatedTokenAddress(usdcMint, owner, true);
      atas.push(ata);
    }
  }
  return atas;
}

async function processRow(
  row: PendingRow,
  connection: Connection,
  authority: Keypair,
  usdcMint: PublicKey,
  affiliateAtas: PublicKey[],
  protocolConfigPda: PublicKey,
  treasuryPda: PublicKey,
  dryRun: boolean,
): Promise<void> {
  const slug = slugFromUuid(row.id);
  const slugHex = Buffer.from(slug).toString("hex");
  const [endpointConfigPda] = getEndpointConfigPda(PROGRAM_ID, slug);
  const [coveragePoolPda] = getCoveragePoolPda(PROGRAM_ID, slug);

  const poolVaultKp = Keypair.generate();

  // Pricing math — derive from amount_usd + preferred_rate_bps.
  const amountUsd = parseFloat(row.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`row ${row.id} has invalid amount_usd ${row.amount_usd}`);
  }
  const imputedCostMicroUsdc = BigInt(Math.round(amountUsd * 1_000_000));
  const flatPremium = BigInt(
    Math.round((amountUsd * 1_000_000 * row.preferred_rate_bps) / 10_000),
  );
  const exposureCapPerHour = imputedCostMicroUsdc * 100n;

  console.log(
    `\n--- row ${row.id} (${row.hostname}${row.endpoint_path}) ---\n` +
      `  slug=${slugHex}\n` +
      `  endpointConfig=${endpointConfigPda.toBase58()}\n` +
      `  coveragePool=${coveragePoolPda.toBase58()}\n` +
      `  poolVault=${poolVaultKp.publicKey.toBase58()}\n` +
      `  amount_usd=${amountUsd} -> imputedCost=${imputedCostMicroUsdc} ` +
      `flatPremium=${flatPremium} (rate ${row.preferred_rate_bps}bps)`,
  );

  // Allocate the pool vault account (165 bytes, owned by SPL Token). The
  // register_endpoint instruction will InitializeAccount3 against this
  // pre-allocated space.
  const rent = await connection.getMinimumBalanceForRentExemption(165);
  const createVaultIx = SystemProgram.createAccount({
    fromPubkey: authority.publicKey,
    newAccountPubkey: poolVaultKp.publicKey,
    lamports: rent,
    space: 165,
    programId: TOKEN_PROGRAM_ID,
  });

  const registerIx = buildRegisterEndpointIx({
    authority: authority.publicKey,
    protocolConfig: protocolConfigPda,
    treasury: treasuryPda,
    endpointConfig: endpointConfigPda,
    coveragePool: coveragePoolPda,
    poolVault: poolVaultKp.publicKey,
    usdcMint,
    slug,
    flatPremiumLamports: flatPremium,
    percentBps: row.preferred_rate_bps,
    slaLatencyMs: 5_000, // Commit 2 default; configurable later.
    imputedCostLamports: imputedCostMicroUsdc,
    exposureCapPerHourLamports: exposureCapPerHour,
    affiliateAtas,
  });

  const tx = new Transaction().add(createVaultIx, registerIx);
  tx.feePayer = authority.publicKey;

  if (dryRun) {
    console.log(
      `  [dry-run] would submit 2 instructions ` +
        `(SystemProgram.createAccount + register_endpoint) signed by ` +
        `${authority.publicKey.toBase58()} + ${poolVaultKp.publicKey.toBase58()}`,
    );
    return;
  }

  const sig = await sendAndConfirmTransaction(
    connection,
    tx,
    [authority, poolVaultKp],
    { commitment: "confirmed" },
  );
  console.log(`  ✓ register_endpoint confirmed: ${sig}`);

  await query(
    `UPDATE merchant_endpoints
        SET status = 'active',
            slug = $1,
            on_chain_tx = $2
      WHERE id = $3`,
    [slugHex, sig, row.id],
  );
  console.log(`  ✓ db status flipped to active`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = process.env.PACT_RPC_URL ?? "https://api.devnet.solana.com";
  const usdcMintStr =
    process.env.PACT_USDC_MINT ??
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // devnet default
  const usdcMint = new PublicKey(usdcMintStr);

  const connection = new Connection(rpcUrl, "confirmed");
  const authority = loadAuthorityKeypair();
  console.log(
    `Authority: ${authority.publicKey.toBase58()}\n` +
      `RPC: ${rpcUrl}\n` +
      `USDC mint: ${usdcMintStr}\n` +
      `Dry run: ${args.dryRun}`,
  );

  const [protocolConfigPda] = getProtocolConfigPda(PROGRAM_ID);
  const [treasuryPda] = getTreasuryPda(PROGRAM_ID);
  const affiliateAtas = await fetchAffiliateAtas(
    connection,
    protocolConfigPda,
    usdcMint,
  );
  console.log(
    `Resolved ${affiliateAtas.length} AffiliateAta entries from ProtocolConfig`,
  );

  const rows = args.allPending
    ? await getMany<PendingRow>(
        `SELECT id, merchant_pubkey, hostname, endpoint_path,
                amount_usd::text, preferred_rate_bps, status
           FROM merchant_endpoints WHERE status = 'pending_review'
           ORDER BY created_at ASC`,
      )
    : await getMany<PendingRow>(
        `SELECT id, merchant_pubkey, hostname, endpoint_path,
                amount_usd::text, preferred_rate_bps, status
           FROM merchant_endpoints WHERE id = $1`,
        [args.id!],
      );

  if (rows.length === 0) {
    console.log("No matching rows.");
    return;
  }
  console.log(`Found ${rows.length} row(s) to process.`);

  for (const row of rows) {
    if (row.status !== "pending_review") {
      console.log(
        `Skipping ${row.id}: status=${row.status} (not pending_review)`,
      );
      continue;
    }
    try {
      await processRow(
        row,
        connection,
        authority,
        usdcMint,
        affiliateAtas,
        protocolConfigPda,
        treasuryPda,
        args.dryRun,
      );
    } catch (err) {
      console.error(`Row ${row.id} failed:`, err);
    }
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
