/**
 * init-devnet.ts — V1 devnet protocol initialization.
 *
 * Twin of scripts/mainnet/init-mainnet.ts but pointed at Solana devnet, with
 * a single `helius` endpoint (vs mainnet's 5) and devnet defaults throughout.
 *
 * Fires up to 4 instructions in strict order:
 *   1. initialize_protocol_config — singleton, sets authority + USDC mint + fee cap
 *   2. initialize_treasury — singleton, creates Treasury PDA + USDC vault account
 *   3. initialize_settlement_authority — registers the settler service's hot signing key
 *   4. register_endpoint("helius") — pre-allocates pool vault + sets fee recipient (Treasury 10%)
 *
 * Each step is idempotent: if the target PDA already exists on-chain, the step
 * is skipped. Safe to re-run.
 *
 * RUN FROM RICK'S LAPTOP. Per plan/devnet-mirror-build §12 settled decisions,
 * the upgrade-authority + settler-signer keypairs may be reused from the
 * existing ~/.config/solana/ dev hot key — just copy or symlink that JSON
 * into $DEVNET_KEYS_DIR/pact-devnet-upgrade-authority.json and
 * $DEVNET_KEYS_DIR/settlement-authority.json before running.
 *
 * Required keypairs at $DEVNET_KEYS_DIR (default ~/pact-devnet-keys):
 *   - pact-network-v1-program-keypair.json   (program ID `5jBQb7fL…`, same one
 *                                             used for the existing devnet deploy)
 *   - pact-devnet-upgrade-authority.json     (devnet hot key; can be a copy/symlink
 *                                             of ~/.config/solana/<your-key>.json)
 *   - settlement-authority.json              (settler service signing key; can be
 *                                             the same key as upgrade-authority on
 *                                             devnet per plan §12)
 *   - treasury-vault.json                    (Treasury USDC vault account — fresh)
 *   - pool-vault-helius.json                 (helius pool USDC vault — fresh)
 *
 * Env (with defaults):
 *   DEVNET_KEYS_DIR=~/pact-devnet-keys
 *   DEVNET_RPC_URL=https://api.devnet.solana.com
 *   DRY_RUN=1   (skip sending; print what would happen)
 *
 * Usage:
 *   cd scripts/devnet
 *   pnpm install
 *   DRY_RUN=1 pnpm init   # rehearsal (recommended first run)
 *   pnpm init             # for real (devnet is cheap; failures are fine, just rerun)
 *
 * State output: scripts/devnet/.devnet-state.json
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  buildInitializeProtocolConfigIx,
  buildInitializeSettlementAuthorityIx,
  buildInitializeTreasuryIx,
  buildRegisterEndpointIx,
  FeeRecipientKind,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getSettlementAuthorityPda,
  getTreasuryPda,
  slugBytes,
  TOKEN_PROGRAM_ID,
  USDC_MINT_DEVNET,
} from "@pact-network/protocol-v1-client";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readKeypair, resolveKeyPath } from "../mainnet/lib/keys";
import { patchState } from "./lib/state";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN_ACCOUNT_LEN = 165;
const MAX_TOTAL_FEE_BPS = 3000;
const DEFAULT_TREASURY_FEE_BPS = 1000; // 10% — overridable in endpoint-config.json

const KEYS_DIR = process.env.DEVNET_KEYS_DIR ?? "~/pact-devnet-keys";
const RPC_URL = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

interface EndpointSpec {
  slug: string;
  flatPremiumLamports: string;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: string;
  exposureCapPerHourLamports: string;
}

interface EndpointConfigFile {
  endpoints: EndpointSpec[];
  treasuryFeeBps?: number;
}

function loadEndpointConfig(): EndpointConfigFile {
  const path = resolve(__dirname, "endpoint-config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as EndpointConfigFile;
  if (!Array.isArray(raw.endpoints) || raw.endpoints.length === 0) {
    throw new Error(`endpoint-config.json must contain a non-empty endpoints array`);
  }
  return raw;
}

function key(name: string): string {
  return `${KEYS_DIR}/${name}`;
}

async function ensureBalance(conn: Connection, pubkey: PublicKey, minSol: number) {
  const bal = await conn.getBalance(pubkey, "confirmed");
  const balSol = bal / 1e9;
  if (bal < minSol * 1e9) {
    throw new Error(
      `${pubkey.toBase58()} has ${balSol.toFixed(4)} SOL on devnet — need >= ${minSol} SOL.\n` +
        `Airdrop: solana airdrop 1 ${pubkey.toBase58()} --url ${RPC_URL}\n` +
        `(devnet faucet caps at 1 SOL/call with ~12h cooldown per IP — retry if rate-limited)`,
    );
  }
  console.log(`  balance OK: ${balSol.toFixed(4)} SOL @ ${pubkey.toBase58()}`);
}

/**
 * Send a tx and confirm via HTTP polling. Devnet public RPC doesn't expose
 * `signatureSubscribe` reliably; polling works everywhere.
 */
async function sendAndPoll(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  commitment: "confirmed" | "finalized" = "confirmed",
  timeoutMs = 90_000,
): Promise<string> {
  if (signers.length === 0) throw new Error("sendAndPoll: at least one signer required");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(commitment);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(...signers);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: commitment,
    maxRetries: 3,
  });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const status = res?.value?.[0];
    if (status?.err) {
      throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(status.err)}`);
    }
    const cs = status?.confirmationStatus as string | undefined;
    if (cs === "finalized" || (commitment === "confirmed" && cs === "confirmed")) {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
}

async function maybeSend(
  label: string,
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  if (DRY_RUN) {
    console.log(`  [DRY_RUN] would send ${label} with ${signers.length} signer(s)`);
    return `DRY_RUN_${label.replace(/\s+/g, "_")}`;
  }
  return sendAndPoll(conn, tx, signers, "confirmed");
}

async function pdaExists(conn: Connection, pda: PublicKey): Promise<boolean> {
  try {
    const acct = await conn.getAccountInfo(pda, "confirmed");
    return acct !== null && acct.data.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`=== Pact Network V1 devnet init ===`);
  console.log(`  RPC:   ${RPC_URL}`);
  console.log(`  Keys:  ${resolveKeyPath(KEYS_DIR)}`);
  console.log(`  Mode:  ${DRY_RUN ? "DRY RUN (no txs sent)" : "REAL (txs will land on devnet)"}\n`);

  const epConfig = loadEndpointConfig();
  const treasuryFeeBps = epConfig.treasuryFeeBps ?? DEFAULT_TREASURY_FEE_BPS;
  if (treasuryFeeBps > MAX_TOTAL_FEE_BPS) {
    throw new Error(
      `treasuryFeeBps=${treasuryFeeBps} exceeds protocol cap MAX_TOTAL_FEE_BPS=${MAX_TOTAL_FEE_BPS}`,
    );
  }

  const conn = new Connection(RPC_URL, "confirmed");

  const programKp = readKeypair(key("pact-network-v1-program-keypair.json"));
  const upgradeAuth = readKeypair(key("pact-devnet-upgrade-authority.json"));
  const settlerSigner = readKeypair(key("settlement-authority.json"));
  const treasuryVault = readKeypair(key("treasury-vault.json"));
  const poolVaults = new Map(
    epConfig.endpoints.map((ep) => [ep.slug, readKeypair(key(`pool-vault-${ep.slug}.json`))]),
  );

  const programId = programKp.publicKey;
  const usdcMint = USDC_MINT_DEVNET;

  console.log(`Program ID:           ${programId.toBase58()}`);
  console.log(`Upgrade authority:    ${upgradeAuth.publicKey.toBase58()}`);
  console.log(`Settlement signer:    ${settlerSigner.publicKey.toBase58()}`);
  console.log(`Treasury vault:       ${treasuryVault.publicKey.toBase58()}`);
  console.log(`USDC mint (devnet):   ${usdcMint.toBase58()}`);
  console.log(`Treasury fee bps:     ${treasuryFeeBps} (${(treasuryFeeBps / 100).toFixed(1)}%)\n`);

  console.log(`Pool vaults:`);
  for (const ep of epConfig.endpoints) {
    console.log(`  ${ep.slug.padEnd(10)} -> ${poolVaults.get(ep.slug)!.publicKey.toBase58()}`);
  }
  console.log("");

  // Pre-flight: confirm program is deployed at the expected address.
  const progAcct = await conn.getAccountInfo(programId, "confirmed");
  if (!progAcct) {
    throw new Error(
      `Program ${programId.toBase58()} not found on ${RPC_URL}.\n` +
        `Devnet program should already be deployed at 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5 — check\n` +
        `solana program show ${programId.toBase58()} --url ${RPC_URL}`,
    );
  }
  console.log(`  program account exists, ${progAcct.data.length} bytes, owner ${progAcct.owner.toBase58()}\n`);

  // Pre-flight: upgrade authority has enough SOL for ~4 txs + vault rents.
  // 0.1 SOL is plenty on devnet; faucet gives 1 SOL/call.
  await ensureBalance(conn, upgradeAuth.publicKey, 0.1);

  patchState({
    programId: programId.toBase58(),
    protocolAuthority: upgradeAuth.publicKey.toBase58(),
    settlementAuthoritySigner: settlerSigner.publicKey.toBase58(),
    usdcMint: usdcMint.toBase58(),
  });

  const sigs: Record<string, string> = {};
  const totalSteps = 3 + epConfig.endpoints.length;

  // ---------- 1. initialize_protocol_config ----------
  const [protocolConfigPda] = getProtocolConfigPda(programId);
  console.log(`[1/${totalSteps}] initialize_protocol_config -> ${protocolConfigPda.toBase58()}`);
  if (!DRY_RUN && (await pdaExists(conn, protocolConfigPda))) {
    console.log(`  already initialized -- skipping\n`);
    sigs.initializeProtocolConfig = "ALREADY_INITIALIZED";
  } else {
    const ix = buildInitializeProtocolConfigIx({
      programId,
      authority: upgradeAuth.publicKey,
      protocolConfig: protocolConfigPda,
      usdcMint,
      defaultFeeRecipients: [],
    });
    const tx = new Transaction().add(ix);
    const sig = await maybeSend("initialize_protocol_config", conn, tx, [upgradeAuth]);
    console.log(`  sig: ${sig}\n`);
    sigs.initializeProtocolConfig = sig;
  }

  // ---------- 2. initialize_treasury ----------
  const [treasuryPda] = getTreasuryPda(programId);
  console.log(`[2/${totalSteps}] initialize_treasury -> PDA ${treasuryPda.toBase58()}`);
  if (!DRY_RUN && (await pdaExists(conn, treasuryPda))) {
    console.log(`  already initialized -- skipping\n`);
    sigs.initializeTreasury = "ALREADY_INITIALIZED";
  } else {
    const rent = DRY_RUN
      ? 2_039_280
      : await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
    const createIx = SystemProgram.createAccount({
      fromPubkey: upgradeAuth.publicKey,
      newAccountPubkey: treasuryVault.publicKey,
      lamports: rent,
      space: TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    });
    const initIx = buildInitializeTreasuryIx({
      programId,
      authority: upgradeAuth.publicKey,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      treasuryVault: treasuryVault.publicKey,
      usdcMint,
    });
    const tx = new Transaction().add(createIx).add(initIx);
    const sig = await maybeSend("initialize_treasury", conn, tx, [upgradeAuth, treasuryVault]);
    console.log(`  sig: ${sig}\n`);
    sigs.initializeTreasury = sig;
  }

  // ---------- 3. initialize_settlement_authority ----------
  const [saPda] = getSettlementAuthorityPda(programId);
  console.log(`[3/${totalSteps}] initialize_settlement_authority -> PDA ${saPda.toBase58()}`);
  if (!DRY_RUN && (await pdaExists(conn, saPda))) {
    console.log(`  already initialized -- skipping\n`);
    sigs.initializeSettlementAuthority = "ALREADY_INITIALIZED";
  } else {
    const ix = buildInitializeSettlementAuthorityIx({
      programId,
      authority: upgradeAuth.publicKey,
      protocolConfig: protocolConfigPda,
      settlementAuthority: saPda,
      settlerSigner: settlerSigner.publicKey,
    });
    const tx = new Transaction().add(ix);
    const sig = await maybeSend("initialize_settlement_authority", conn, tx, [upgradeAuth]);
    console.log(`  sig: ${sig}\n`);
    sigs.initializeSettlementAuthority = sig;
  }

  // ---------- 4. register_endpoint × N (just `helius` for now) ----------
  const recorded: Parameters<typeof patchState>[0]["endpoints"] = [];
  let step = 4;

  for (const ep of epConfig.endpoints) {
    const slug = slugBytes(ep.slug);
    const [endpointConfigPda] = getEndpointConfigPda(programId, slug);
    const [coveragePool] = getCoveragePoolPda(programId, slug);
    const poolVault = poolVaults.get(ep.slug)!;

    console.log(
      `[${step}/${totalSteps}] register_endpoint("${ep.slug}")\n` +
        `  endpointConfig: ${endpointConfigPda.toBase58()}\n` +
        `  coveragePool:   ${coveragePool.toBase58()}\n` +
        `  poolVault:      ${poolVault.publicKey.toBase58()}\n` +
        `  premium:        ${ep.flatPremiumLamports} (${(Number(ep.flatPremiumLamports) / 1_000_000).toFixed(6)} USDC)\n` +
        `  imputed cost:   ${ep.imputedCostLamports} (${(Number(ep.imputedCostLamports) / 1_000_000).toFixed(6)} USDC)\n` +
        `  SLA:            ${ep.slaLatencyMs}ms`,
    );

    if (!DRY_RUN && (await pdaExists(conn, endpointConfigPda))) {
      console.log(`  already registered -- skipping\n`);
      sigs[`registerEndpoint:${ep.slug}`] = "ALREADY_INITIALIZED";
    } else {
      const rent = DRY_RUN
        ? 2_039_280
        : await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
      const createIx = SystemProgram.createAccount({
        fromPubkey: upgradeAuth.publicKey,
        newAccountPubkey: poolVault.publicKey,
        lamports: rent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      });
      const regIx = buildRegisterEndpointIx({
        programId,
        authority: upgradeAuth.publicKey,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        endpointConfig: endpointConfigPda,
        coveragePool,
        poolVault: poolVault.publicKey,
        usdcMint,
        slug,
        flatPremiumLamports: BigInt(ep.flatPremiumLamports),
        percentBps: ep.percentBps,
        slaLatencyMs: ep.slaLatencyMs,
        imputedCostLamports: BigInt(ep.imputedCostLamports),
        exposureCapPerHourLamports: BigInt(ep.exposureCapPerHourLamports),
        feeRecipients: [
          {
            kind: FeeRecipientKind.Treasury,
            destination: treasuryPda.toBase58(),
            bps: treasuryFeeBps,
          },
        ],
        feeRecipientCount: 1,
      });
      const tx = new Transaction().add(createIx).add(regIx);
      const sig = await maybeSend(
        `register_endpoint:${ep.slug}`,
        conn,
        tx,
        [upgradeAuth, poolVault],
      );
      console.log(`  sig: ${sig}\n`);
      sigs[`registerEndpoint:${ep.slug}`] = sig;
    }

    recorded!.push({
      slug: ep.slug,
      endpointConfigPda: endpointConfigPda.toBase58(),
      coveragePool: coveragePool.toBase58(),
      poolVault: poolVault.publicKey.toBase58(),
      flatPremiumLamports: ep.flatPremiumLamports,
      percentBps: ep.percentBps,
      slaLatencyMs: ep.slaLatencyMs,
      imputedCostLamports: ep.imputedCostLamports,
      exposureCapPerHourLamports: ep.exposureCapPerHourLamports,
    });
    step++;
  }

  patchState({
    protocolConfigPda: protocolConfigPda.toBase58(),
    treasuryPda: treasuryPda.toBase58(),
    treasuryVault: treasuryVault.publicKey.toBase58(),
    settlementAuthorityPda: saPda.toBase58(),
    endpoints: recorded,
    signatures: sigs,
  });

  console.log(`\n=== devnet init ${DRY_RUN ? "REHEARSAL" : "COMPLETE"} ===`);
  console.log(`State written to scripts/devnet/.devnet-state.json`);
  console.log(`\nVerification:`);
  console.log(`  solana program show ${programId.toBase58()} --url ${RPC_URL}`);
  console.log(`  solana account ${protocolConfigPda.toBase58()} --url ${RPC_URL}`);
  console.log(`  solana account ${treasuryPda.toBase58()} --url ${RPC_URL}`);
  for (const ep of recorded!) {
    console.log(`  solana account ${ep.coveragePool} --url ${RPC_URL}  # ${ep.slug}`);
  }
  console.log(
    `\nNext: paste the SETTLEMENT_AUTHORITY signer pubkey (${settlerSigner.publicKey.toBase58()})\n` +
      `into the Railway settler service env (base58-encoded keypair from\n` +
      `${KEYS_DIR}/settlement-authority.json), fund it with >=0.05 devnet SOL,\n` +
      `then run scripts/devnet-smoke/health.sh.`,
  );
}

main().catch((e) => {
  console.error("\nINIT FAILED:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
