#!/usr/bin/env node
/**
 * dummy-coverage-pool.ts — register the `dummy` endpoint on-chain (creating
 * its per-slug CoveragePool PDA + USDC vault) and fund that pool, so the
 * premium-coverage path can pay refunds for `pact https://dummy.pactnetwork.io/...`.
 *
 * Protocol model recap (Pact Network V1 — pact-network-v1-pinocchio):
 *   - Each endpoint owns its own CoveragePool, derived from
 *     `[b"coverage_pool", slug]`. Pool + endpoint are co-created atomically by
 *     `register_endpoint` — an endpoint can never exist without its pool.
 *     `register_endpoint` also pre-allocates the pool's USDC vault (a fresh
 *     165-byte SPL Token account the caller funds with rent; the program binds
 *     it to mint + pool PDA via InitializeAccount3) and copies a fee-recipient
 *     array (defaults to `[Treasury 10%]` here).
 *   - `coverage_pool.authority` is set to the protocol authority (the signer
 *     of `register_endpoint`). Only that key can later `top_up_coverage_pool`,
 *     which pulls USDC from `authority_ata` into `pool_vault` (no delegate).
 *   - On a covered failure (server_error / latency_breach / network_error) the
 *     settler's `settle_batch` transfers `refund_lamports` (= the endpoint's
 *     `imputed_cost_lamports`) out of `pool_vault` to the agent's USDC ATA,
 *     subject to the endpoint's hourly `exposure_cap_per_hour_lamports`. The
 *     premium itself is pulled from the AGENT'S ATA (delegate = SettlementAuthority
 *     PDA) — the pool is purely the refund reservoir.
 *
 * What this script does (idempotent — re-running is safe):
 *   1. Reads PROGRAM_ID, RPC, USDC mint, and the protocol-authority keypair.
 *   2. Derives ProtocolConfig / Treasury / EndpointConfig("dummy") / CoveragePool("dummy") PDAs.
 *   3. If EndpointConfig("dummy") does NOT exist: builds + sends
 *      [SystemProgram.createAccount(poolVault, 165B), register_endpoint("dummy", ...)]
 *      signed by [authority, poolVaultKeypair]. Reuses an existing pool-vault
 *      keypair file if present (so re-runs don't orphan vaults).
 *   4. If EndpointConfig("dummy") DOES exist: skips registration.
 *   5. Reads the CoveragePool to find its `usdc_vault`.
 *   6. Builds + sends `top_up_coverage_pool("dummy", SEED_USDC_LAMPORTS)` from
 *      the authority's USDC ATA. (The ATA must already exist and hold the USDC.)
 *
 * Endpoint config values (USDC base units, 6 decimals — keep in sync with
 * packages/db/seeds/dummy-endpoint.sql):
 *   flatPremiumLamports        = 1000      ($0.001/call)
 *   percentBps                 = 0         (flat-only)
 *   slaLatencyMs               = 2000      (2s SLA; ?latency=2500 breaches)
 *   imputedCostLamports        = 10000     ($0.01 refunded on a covered failure)
 *   exposureCapPerHourLamports = 1000000   ($1.00/rolling-hour pool payout cap)
 *   treasuryFeeBps             = 1000      (10% of premium → Treasury, residual stays in pool)
 *
 * Seed amount: SEED_USDC_LAMPORTS = 1_000_000 (= 1.00 USDC). Covers 100 full
 * $0.01 refunds — well past anything a demo needs. The hourly exposure cap
 * ($1.00) clamps before the pool empties anyway.
 *
 * !!! DO NOT RUN AGAINST MAINNET FOR THE MVP. !!! Devnet/staging only. There
 * is a `--confirm` gate; without it the script does a dry run (prints the
 * planned txs + derived addresses, sends nothing).
 *
 * Required env:
 *   PACT_PRIVATE_KEY   base58 secret key OR path to a Solana keypair JSON file.
 *                      = the protocol authority (ProtocolConfig.authority). Used
 *                      to sign register_endpoint AND top_up_coverage_pool.
 *                      This wallet's USDC ATA must hold ≥ SEED_USDC_LAMPORTS.
 *   PACT_RPC_URL       Solana RPC (use a Helius/Alchemy URL with an API key —
 *                      api.devnet.solana.com 429s under any load).
 * Optional env:
 *   PROGRAM_ID         defaults to the protocol-v1-client PROGRAM_ID constant
 *                      (currently the mainnet deploy). For devnet, set this to
 *                      your devnet deploy's program ID.
 *   USDC_MINT          defaults to USDC_MINT_DEVNET. Set to your test mint /
 *                      USDC_MINT_MAINNET to match the program's hardcoded mint.
 *   POOL_VAULT_KEYPAIR path to a JSON keypair file used as the pool USDC vault
 *                      account on first register. Generated + written here if
 *                      absent. Default: ./scripts/.dummy-pool-vault.json.
 *   SEED_USDC_LAMPORTS override the seed amount (default 1000000 = 1.00 USDC).
 *
 * Usage:
 *   # dry run (prints plan, sends nothing):
 *   PACT_PRIVATE_KEY=~/.config/solana/pact-devnet-authority.json \
 *   PACT_RPC_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   PROGRAM_ID=<devnet-program-id> USDC_MINT=<devnet-usdc-mint> \
 *     pnpm exec tsx scripts/dummy-coverage-pool.ts
 *
 *   # for real (devnet):
 *   ... pnpm exec tsx scripts/dummy-coverage-pool.ts --confirm
 *
 * Verify afterward:
 *   solana account <coveragePool PDA> --url $PACT_RPC_URL          # endpoint_slug = "dummy", current_balance > 0
 *   solana account <endpointConfig PDA> --url $PACT_RPC_URL        # paused = 0, flat_premium_lamports = 1000
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  buildRegisterEndpointIx,
  buildTopUpCoveragePoolIx,
  decodeCoveragePool,
  deriveAssociatedTokenAccount,
  FeeRecipientKind,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getTreasuryPda,
  PROGRAM_ID as DEFAULT_PROGRAM_ID,
  slugBytes,
  TOKEN_PROGRAM_ID,
  USDC_MINT_DEVNET,
} from "@pact-network/protocol-v1-client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import bs58 from "bs58";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SLUG = "dummy";
const FLAT_PREMIUM_LAMPORTS = 1_000n; // $0.001/call
const PERCENT_BPS = 0; // flat-only
const SLA_LATENCY_MS = 2_000; // 2s SLA
const IMPUTED_COST_LAMPORTS = 10_000n; // $0.01 refunded on a covered failure
const EXPOSURE_CAP_PER_HOUR_LAMPORTS = 1_000_000n; // $1.00/rolling hour
const TREASURY_FEE_BPS = 1_000; // 10% → Treasury
const TOKEN_ACCOUNT_LEN = 165;
const DEFAULT_SEED_USDC_LAMPORTS = 1_000_000n; // 1.00 USDC
const DEFAULT_POOL_VAULT_KEYPAIR = resolvePath(
  process.cwd(),
  "scripts",
  ".dummy-pool-vault.json",
);

const CONFIRM = process.argv.includes("--confirm");

// ---------------------------------------------------------------------------
// Keypair / env helpers
// ---------------------------------------------------------------------------
function expandTilde(p: string): string {
  return p.startsWith("~/") ? resolvePath(homedir(), p.slice(2)) : resolvePath(p);
}

function loadKeypairFromEnv(name: string): Keypair {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  // JSON keypair file?
  if (raw.trim().startsWith("[") || existsSync(expandTilde(raw))) {
    const path = raw.trim().startsWith("[") ? null : expandTilde(raw);
    const json = path ? readFileSync(path, "utf8") : raw;
    const bytes = JSON.parse(json);
    if (!Array.isArray(bytes) || bytes.length !== 64) {
      throw new Error(`${name}: expected a 64-byte JSON array keypair`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  // base58 secret key
  const sk = bs58.decode(raw.trim());
  if (sk.length !== 64) {
    throw new Error(`${name}: base58 secret key must decode to 64 bytes (got ${sk.length})`);
  }
  return Keypair.fromSecretKey(sk);
}

function loadOrCreatePoolVaultKeypair(path: string): { kp: Keypair; created: boolean } {
  if (existsSync(path)) {
    const bytes = JSON.parse(readFileSync(path, "utf8"));
    return { kp: Keypair.fromSecretKey(Uint8Array.from(bytes)), created: false };
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return { kp, created: true };
}

async function pdaExists(conn: Connection, pda: PublicKey): Promise<boolean> {
  const acct = await conn.getAccountInfo(pda, "confirmed");
  return acct !== null && acct.data.length > 0;
}

async function sendAndPoll(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  timeoutMs = 90_000,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = (await conn.getSignatureStatuses([sig])).value?.[0];
    if (st?.err) throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const rpcUrl = process.env.PACT_RPC_URL;
  if (!rpcUrl) throw new Error("PACT_RPC_URL is required");
  const programId = new PublicKey(process.env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID.toBase58());
  const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_MINT_DEVNET.toBase58());
  const seedUsdc = BigInt(process.env.SEED_USDC_LAMPORTS ?? DEFAULT_SEED_USDC_LAMPORTS.toString());
  const poolVaultKeypairPath = process.env.POOL_VAULT_KEYPAIR ?? DEFAULT_POOL_VAULT_KEYPAIR;

  const authority = loadKeypairFromEnv("PACT_PRIVATE_KEY");
  const conn = new Connection(rpcUrl, "confirmed");

  const slugBuf = slugBytes(SLUG);
  const [protocolConfigPda] = getProtocolConfigPda(programId);
  const [treasuryPda] = getTreasuryPda(programId);
  const [endpointConfigPda] = getEndpointConfigPda(programId, slugBuf);
  const [coveragePoolPda] = getCoveragePoolPda(programId, slugBuf);
  const authorityUsdcAta = deriveAssociatedTokenAccount(authority.publicKey, usdcMint);

  console.log("=== Pact Network — dummy coverage pool ===");
  console.log(`  mode:             ${CONFIRM ? "REAL (txs will land)" : "DRY RUN (sends nothing — pass --confirm)"}`);
  console.log(`  RPC:              ${rpcUrl}`);
  console.log(`  program:          ${programId.toBase58()}`);
  console.log(`  USDC mint:        ${usdcMint.toBase58()}`);
  console.log(`  authority:        ${authority.publicKey.toBase58()}`);
  console.log(`  authority USDC ATA: ${authorityUsdcAta.toBase58()}`);
  console.log(`  ProtocolConfig:   ${protocolConfigPda.toBase58()}`);
  console.log(`  Treasury PDA:     ${treasuryPda.toBase58()}`);
  console.log(`  EndpointConfig:   ${endpointConfigPda.toBase58()}  (slug="${SLUG}")`);
  console.log(`  CoveragePool:     ${coveragePoolPda.toBase58()}`);
  console.log(`  seed amount:      ${seedUsdc} (${(Number(seedUsdc) / 1e6).toFixed(6)} USDC)`);
  console.log(`  endpoint config:  flatPremium=${FLAT_PREMIUM_LAMPORTS} percentBps=${PERCENT_BPS} slaMs=${SLA_LATENCY_MS} imputed=${IMPUTED_COST_LAMPORTS} exposureCap/hr=${EXPOSURE_CAP_PER_HOUR_LAMPORTS} treasuryFeeBps=${TREASURY_FEE_BPS}`);
  console.log("");

  if (/mainnet/i.test(rpcUrl) || usdcMint.equals(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))) {
    if (process.env.ALLOW_MAINNET !== "1") {
      throw new Error("Refusing to run against mainnet for the MVP. Set ALLOW_MAINNET=1 to override (you almost certainly should not).");
    }
  }

  // ---- Pre-flight ----------------------------------------------------------
  if (!(await pdaExists(conn, protocolConfigPda))) {
    throw new Error(`ProtocolConfig ${protocolConfigPda.toBase58()} not initialised. Run the protocol init (init-mainnet.ts / a devnet equivalent) first.`);
  }
  if (!(await pdaExists(conn, treasuryPda))) {
    throw new Error(`Treasury ${treasuryPda.toBase58()} not initialised. Run initialize_treasury first.`);
  }

  // ---- Step 1: register_endpoint (creates EndpointConfig + CoveragePool + vault) ----
  const alreadyRegistered = await pdaExists(conn, endpointConfigPda);
  if (alreadyRegistered) {
    console.log(`[1/2] register_endpoint("${SLUG}") — already registered, skipping.`);
  } else {
    const { kp: poolVaultKp, created } = loadOrCreatePoolVaultKeypair(poolVaultKeypairPath);
    console.log(`[1/2] register_endpoint("${SLUG}")`);
    console.log(`      pool vault keypair: ${poolVaultKeypairPath} (${created ? "generated" : "reused"})`);
    console.log(`      pool vault pubkey:  ${poolVaultKp.publicKey.toBase58()}`);
    const rent = CONFIRM
      ? await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN)
      : 2_039_280;
    const createIx = SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: poolVaultKp.publicKey,
      lamports: rent,
      space: TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    });
    const regIx = buildRegisterEndpointIx({
      programId,
      authority: authority.publicKey,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      endpointConfig: endpointConfigPda,
      coveragePool: coveragePoolPda,
      poolVault: poolVaultKp.publicKey,
      usdcMint,
      slug: slugBuf,
      flatPremiumLamports: FLAT_PREMIUM_LAMPORTS,
      percentBps: PERCENT_BPS,
      slaLatencyMs: SLA_LATENCY_MS,
      imputedCostLamports: IMPUTED_COST_LAMPORTS,
      exposureCapPerHourLamports: EXPOSURE_CAP_PER_HOUR_LAMPORTS,
      // Single Treasury fee recipient — destination is substituted on-chain
      // with the canonical Treasury.usdc_vault; no AffiliateAta entries, so no
      // extra affiliateAtas accounts needed.
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: treasuryPda.toBase58(), bps: TREASURY_FEE_BPS },
      ],
      feeRecipientCount: 1,
    });
    if (!CONFIRM) {
      console.log(`      [DRY RUN] would send [createAccount(poolVault), register_endpoint] signed by [authority, poolVault].`);
    } else {
      const sig = await sendAndPoll(conn, new Transaction().add(createIx).add(regIx), [authority, poolVaultKp]);
      console.log(`      sig: ${sig}`);
    }
  }
  console.log("");

  // ---- Step 2: top_up_coverage_pool ---------------------------------------
  console.log(`[2/2] top_up_coverage_pool("${SLUG}", ${seedUsdc})`);
  let poolVaultPubkey: PublicKey;
  if (alreadyRegistered || CONFIRM) {
    const poolAcct = await conn.getAccountInfo(coveragePoolPda, "confirmed");
    if (!poolAcct) {
      throw new Error(`CoveragePool ${coveragePoolPda.toBase58()} not found on-chain after register step.`);
    }
    poolVaultPubkey = new PublicKey(decodeCoveragePool(poolAcct.data).usdcVault);
  } else {
    // Dry run, endpoint not yet registered — the vault would be the keypair
    // we just (re)loaded above. Re-derive it here for the printout.
    const { kp } = loadOrCreatePoolVaultKeypair(poolVaultKeypairPath);
    poolVaultPubkey = kp.publicKey;
  }
  console.log(`      pool USDC vault:  ${poolVaultPubkey.toBase58()}`);
  console.log(`      source ATA:       ${authorityUsdcAta.toBase58()}  (must already exist + hold ≥ ${seedUsdc} USDC base units)`);

  const topUpIx = buildTopUpCoveragePoolIx({
    programId,
    authority: authority.publicKey,
    coveragePool: coveragePoolPda,
    authorityAta: authorityUsdcAta,
    poolVault: poolVaultPubkey,
    slug: slugBuf,
    amount: seedUsdc,
  });
  if (!CONFIRM) {
    console.log(`      [DRY RUN] would send [top_up_coverage_pool] signed by [authority].`);
  } else {
    const ataAcct = await conn.getAccountInfo(authorityUsdcAta, "confirmed");
    if (!ataAcct) {
      throw new Error(`Authority USDC ATA ${authorityUsdcAta.toBase58()} does not exist. Create it (spl-token create-account ${usdcMint.toBase58()}) and fund it with ≥ ${seedUsdc} base units first.`);
    }
    const sig = await sendAndPoll(conn, new Transaction().add(topUpIx), [authority]);
    console.log(`      sig: ${sig}`);
  }

  console.log("");
  console.log(`=== ${CONFIRM ? "DONE" : "DRY RUN COMPLETE"} ===`);
  if (CONFIRM) {
    console.log("Verify:");
    console.log(`  solana account ${coveragePoolPda.toBase58()} --url ${rpcUrl}    # endpoint_slug "dummy", current_balance > 0`);
    console.log(`  solana account ${endpointConfigPda.toBase58()} --url ${rpcUrl}  # paused=0, flat_premium_lamports=1000`);
  } else {
    console.log("Re-run with --confirm to actually register + fund (devnet/staging only).");
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
