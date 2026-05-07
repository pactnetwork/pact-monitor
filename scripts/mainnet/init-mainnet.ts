/**
 * init-mainnet.ts — V1 mainnet protocol initialization.
 *
 * Fires 8 instructions in strict order:
 *   1. initialize_protocol_config — singleton, sets authority + USDC mint + max_total_fee_bps cap
 *   2. initialize_treasury — singleton, creates Treasury PDA + USDC vault account
 *   3. initialize_settlement_authority — registers the settler service's hot signing key
 *   4..8. register_endpoint × 5 — one per slug in endpoint-config.json
 *
 * Each register_endpoint pre-allocates a per-endpoint pool USDC vault and
 * supplies a single Treasury fee recipient at `treasuryFeeBps` (default 1000 = 10%).
 *
 * RUN FROM RICK'S LAPTOP. The upgrade-authority keypair NEVER touches the dev VM.
 *
 * Pre-flight:
 *   - All keypair files present in $MAINNET_KEYS_DIR (default: ~/pact-mainnet-keys)
 *   - Upgrade-authority funded with ≥1.5 SOL mainnet
 *   - Program already deployed (run scripts/mainnet/02-deploy.sh first or `solana program deploy` manually)
 *   - endpoint-config.json reviewed and finalised
 *
 * Required keypairs at $MAINNET_KEYS_DIR:
 *   - pact-network-v1-program-keypair.json     (program ID, baked into the binary's declare_id!)
 *   - pact-mainnet-upgrade-authority.json      (protocol authority + Treasury authority + tx fee payer)
 *   - settlement-authority.json                (settler service signing key — separate from upgrade auth)
 *   - treasury-vault.json                      (Treasury USDC vault account)
 *   - pool-vault-helius.json
 *   - pool-vault-birdeye.json
 *   - pool-vault-jupiter.json
 *   - pool-vault-elfa.json
 *   - pool-vault-fal.json
 *
 * Env (with defaults):
 *   MAINNET_KEYS_DIR=~/pact-mainnet-keys
 *   MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
 *                   (use your Alchemy mainnet endpoint for better reliability)
 *   DRY_RUN=1       (skip sending; print what would happen — recommended first run)
 *
 * Usage:
 *   cd scripts/mainnet
 *   bun install
 *   DRY_RUN=1 bun init-mainnet.ts   # rehearsal
 *   bun init-mainnet.ts             # for real
 *
 * Verification afterward:
 *   solana program show <PROGRAM_ID> --url $MAINNET_RPC_URL
 *   solana account <PROTOCOL_CONFIG_PDA>  --url $MAINNET_RPC_URL
 *   solana account <TREASURY_PDA>         --url $MAINNET_RPC_URL
 *   solana account <COVERAGE_POOL_PDA>    --url $MAINNET_RPC_URL  # × 5 endpoints
 *
 * State output: scripts/mainnet/.mainnet-state.json — commit this AFTER review.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
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
  USDC_MINT_MAINNET,
} from "@pact-network/protocol-v1-client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readKeypair, resolveKeyPath } from "./lib/keys";
import { patchState } from "./lib/state";

const TOKEN_ACCOUNT_LEN = 165;
const MAX_TOTAL_FEE_BPS = 3000; // 30% upper bound — protocol-level cap
const DEFAULT_TREASURY_FEE_BPS = 1000; // 10% — overridable in endpoint-config.json

const KEYS_DIR = process.env.MAINNET_KEYS_DIR ?? "~/pact-mainnet-keys";
const RPC_URL = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
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
      `${pubkey.toBase58()} has ${balSol.toFixed(4)} SOL on mainnet — need ≥ ${minSol} SOL.\n` +
        `Send SOL to this address and retry.`,
    );
  }
  console.log(`  balance OK: ${balSol.toFixed(4)} SOL @ ${pubkey.toBase58()}`);
}

async function maybeSend(
  label: string,
  conn: Connection,
  tx: Transaction,
  signers: Parameters<typeof sendAndConfirmTransaction>[2],
): Promise<string> {
  if (DRY_RUN) {
    console.log(`  [DRY_RUN] would send ${label} with ${signers.length} signer(s)`);
    return `DRY_RUN_${label.replace(/\s+/g, "_")}`;
  }
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

async function main() {
  console.log(`=== Pact Network V1 mainnet init ===`);
  console.log(`  RPC:   ${RPC_URL}`);
  console.log(`  Keys:  ${resolveKeyPath(KEYS_DIR)}`);
  console.log(`  Mode:  ${DRY_RUN ? "DRY RUN (no txs sent)" : "REAL (txs will land on mainnet)"}\n`);

  const epConfig = loadEndpointConfig();
  const treasuryFeeBps = epConfig.treasuryFeeBps ?? DEFAULT_TREASURY_FEE_BPS;
  if (treasuryFeeBps > MAX_TOTAL_FEE_BPS) {
    throw new Error(
      `treasuryFeeBps=${treasuryFeeBps} exceeds protocol cap MAX_TOTAL_FEE_BPS=${MAX_TOTAL_FEE_BPS}`,
    );
  }

  const conn = new Connection(RPC_URL, "confirmed");

  // Read all keypairs up front so a missing file fails fast.
  const programKp = readKeypair(key("pact-network-v1-program-keypair.json"));
  const upgradeAuth = readKeypair(key("pact-mainnet-upgrade-authority.json"));
  const settlerSigner = readKeypair(key("settlement-authority.json"));
  const treasuryVault = readKeypair(key("treasury-vault.json"));
  const poolVaults = new Map(
    epConfig.endpoints.map((ep) => [ep.slug, readKeypair(key(`pool-vault-${ep.slug}.json`))]),
  );

  const programId = programKp.publicKey;
  const usdcMint = USDC_MINT_MAINNET;

  console.log(`Program ID:           ${programId.toBase58()}`);
  console.log(`Upgrade authority:    ${upgradeAuth.publicKey.toBase58()}`);
  console.log(`Settlement signer:    ${settlerSigner.publicKey.toBase58()}`);
  console.log(`Treasury vault:       ${treasuryVault.publicKey.toBase58()}`);
  console.log(`USDC mint (mainnet):  ${usdcMint.toBase58()}`);
  console.log(`Treasury fee bps:     ${treasuryFeeBps} (${(treasuryFeeBps / 100).toFixed(1)}%)\n`);

  console.log(`Pool vaults:`);
  for (const ep of epConfig.endpoints) {
    console.log(`  ${ep.slug.padEnd(10)} → ${poolVaults.get(ep.slug)!.publicKey.toBase58()}`);
  }
  console.log("");

  // Pre-flight: confirm program is actually deployed at the expected address.
  const progAcct = await conn.getAccountInfo(programId, "confirmed");
  if (!progAcct) {
    throw new Error(
      `Program ${programId.toBase58()} not found on ${RPC_URL}.\n` +
        `Deploy first: solana program deploy --program-id <program-keypair> <pact_network_v1.so>`,
    );
  }
  console.log(`  program account exists, ${progAcct.data.length} bytes, owner ${progAcct.owner.toBase58()}\n`);

  // Pre-flight: upgrade authority funded enough for ~8 txs + Treasury vault rent.
  await ensureBalance(conn, upgradeAuth.publicKey, 0.5);

  patchState({
    programId: programId.toBase58(),
    protocolAuthority: upgradeAuth.publicKey.toBase58(),
    settlementAuthoritySigner: settlerSigner.publicKey.toBase58(),
    usdcMint: usdcMint.toBase58(),
  });

  const sigs: Record<string, string> = {};

  // ---------- 1. initialize_protocol_config ----------
  const [protocolConfigPda] = getProtocolConfigPda(programId);
  console.log(`[1/8] initialize_protocol_config → ${protocolConfigPda.toBase58()}`);
  {
    const ix = buildInitializeProtocolConfigIx({
      programId,
      authority: upgradeAuth.publicKey,
      protocolConfig: protocolConfigPda,
      usdcMint,
      defaultFeeRecipients: [], // per-endpoint fee recipients instead
    });
    const tx = new Transaction().add(ix);
    const sig = await maybeSend("initialize_protocol_config", conn, tx, [upgradeAuth]);
    console.log(`  sig: ${sig}\n`);
    sigs.initializeProtocolConfig = sig;
  }

  // ---------- 2. initialize_treasury ----------
  const [treasuryPda] = getTreasuryPda(programId);
  console.log(`[2/8] initialize_treasury → PDA ${treasuryPda.toBase58()}`);
  {
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
  console.log(`[3/8] initialize_settlement_authority → PDA ${saPda.toBase58()}`);
  {
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

  // ---------- 4..8. register_endpoint × N ----------
  const endpointSnapshots: NonNullable<
    Awaited<ReturnType<typeof patchState>> extends never ? never : never
  >[] = [];
  const recorded: Parameters<typeof patchState>[0]["endpoints"] = [];
  let step = 4;

  for (const ep of epConfig.endpoints) {
    const slug = slugBytes(ep.slug);
    const [endpointConfigPda] = getEndpointConfigPda(programId, slug);
    const [coveragePool] = getCoveragePoolPda(programId, slug);
    const poolVault = poolVaults.get(ep.slug)!;

    console.log(
      `[${step}/${3 + epConfig.endpoints.length}] register_endpoint("${ep.slug}")\n` +
        `  endpointConfig: ${endpointConfigPda.toBase58()}\n` +
        `  coveragePool:   ${coveragePool.toBase58()}\n` +
        `  poolVault:      ${poolVault.publicKey.toBase58()}\n` +
        `  premium:        ${ep.flatPremiumLamports} (${(Number(ep.flatPremiumLamports) / 1_000_000).toFixed(6)} USDC)\n` +
        `  imputed cost:   ${ep.imputedCostLamports} (${(Number(ep.imputedCostLamports) / 1_000_000).toFixed(6)} USDC)\n` +
        `  SLA:            ${ep.slaLatencyMs}ms`,
    );

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

  console.log(`\n=== mainnet init ${DRY_RUN ? "REHEARSAL" : "COMPLETE"} ===`);
  console.log(`State written to scripts/mainnet/.mainnet-state.json`);
  console.log(`\nVerification:`);
  console.log(`  solana program show ${programId.toBase58()} --url ${RPC_URL}`);
  console.log(`  solana account ${protocolConfigPda.toBase58()} --url ${RPC_URL}`);
  console.log(`  solana account ${treasuryPda.toBase58()} --url ${RPC_URL}`);
  for (const ep of recorded!) {
    console.log(`  solana account ${ep.coveragePool} --url ${RPC_URL}  # ${ep.slug}`);
  }
  console.log(`\nNext: seed pools with USDC, then deploy off-chain stack to Cloud Run.`);
}

main().catch((e) => {
  console.error("\nINIT FAILED:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
