#!/usr/bin/env node
/**
 * pay-default-bootstrap.ts — register the `pay-default` synthetic endpoint
 * on-chain (creating its per-slug CoveragePool PDA + USDC vault) and fund that
 * pool with a small Pact subsidy, so `facilitator.pact.network` can pay refunds
 * for pay.sh / x402-covered calls.
 *
 * Modeled on scripts/dummy-coverage-pool.ts. The ONE behavioural difference:
 * this script PERMITS mainnet — behind an explicit `--mainnet` flag — because
 * the operator runs it on mainnet (the `pay-default` pool is a real product
 * pool, unlike `dummy` which is devnet-only). Without `--mainnet` it refuses
 * to touch a mainnet RPC / the mainnet USDC mint. (The `--confirm` gate is
 * unchanged: without it the script does a dry run and sends nothing.)
 *
 * Protocol model recap (Pact Network V1 — pact-network-v1-pinocchio):
 *   - Each endpoint owns its own CoveragePool, derived from
 *     `[b"coverage_pool", slug]`. Pool + endpoint are co-created atomically by
 *     `register_endpoint` — an endpoint can never exist without its pool.
 *     `register_endpoint` also pre-allocates the pool's USDC vault (a fresh
 *     165-byte SPL Token account the caller funds with rent; the program binds
 *     it to mint + pool PDA via InitializeAccount3) and copies a fee-recipient
 *     array (defaults to `[Treasury 10%]` here).
 *   - `coverage_pool.authority` is the protocol authority (the signer of
 *     `register_endpoint`). Only that key can later `top_up_coverage_pool`,
 *     which pulls USDC from `authority_ata` into `pool_vault` (no delegate).
 *   - For a pay.sh-covered call the facilitator publishes a SettlementEvent
 *     with endpointSlug = "pay-default", premiumLamports = the flat premium,
 *     refundLamports = the amount the agent paid the merchant (capped at the
 *     endpoint's imputed_cost_lamports, then clamped on-chain by
 *     exposure_cap_per_hour_lamports). The settler's settle_batch pulls the
 *     premium from the AGENT'S USDC ATA (delegate = SettlementAuthority PDA),
 *     splits 10% → Treasury / residual → pay-default pool, and on a covered
 *     breach transfers the refund pay-default-pool-vault → agent USDC ATA.
 *
 * What this script does (idempotent — re-running is safe):
 *   1. Reads PROGRAM_ID, RPC, USDC mint, and the protocol-authority keypair.
 *   2. Derives ProtocolConfig / Treasury / EndpointConfig("pay-default") /
 *      CoveragePool("pay-default") PDAs.
 *   3. If EndpointConfig("pay-default") does NOT exist: builds + sends
 *      [SystemProgram.createAccount(poolVault, 165B), register_endpoint("pay-default", ...)]
 *      signed by [authority, poolVaultKeypair]. Reuses an existing pool-vault
 *      keypair file if present (so re-runs don't orphan vaults).
 *   4. If EndpointConfig("pay-default") DOES exist: skips registration.
 *   5. Reads the CoveragePool to find its `usdc_vault`.
 *   6. Builds + sends `top_up_coverage_pool("pay-default", SEED_USDC_LAMPORTS)`
 *      from the authority's USDC ATA. (The ATA must already exist and hold the USDC.)
 *
 * Endpoint config values (USDC base units, 6 decimals — keep in sync with
 * packages/db/seeds/pay-default-endpoint.sql + .ts):
 *   flatPremiumLamports        = 1_000      ($0.001/call)
 *   percentBps                 = 0          (flat-only)
 *   slaLatencyMs               = 10_000     (10s SLA; pay.sh calls are full HTTP round-trips)
 *   imputedCostLamports        = 1_000_000  ($1.00 per-call refund ceiling — refund = amount paid, capped at this)
 *   exposureCapPerHourLamports = 5_000_000  ($5.00/rolling-hour pool payout cap — tight subsidised-launch float)
 *   treasuryFeeBps             = 1_000      (10% of premium → Treasury, residual stays in pool)
 *
 * Seed amount: SEED_USDC_LAMPORTS = 25_000_000 (= 25.00 USDC). Covers ~25 full
 * $1.00 refunds — well past launch needs; the $5.00/rolling-hour exposure cap
 * clamps before the pool empties anyway. Top up (re-run with --confirm) as
 * volume grows.
 *
 * Required env:
 *   PACT_PRIVATE_KEY   base58 secret key OR path to a Solana keypair JSON file.
 *                      = the protocol authority (ProtocolConfig.authority). Used
 *                      to sign register_endpoint AND top_up_coverage_pool.
 *                      This wallet's USDC ATA must hold ≥ SEED_USDC_LAMPORTS.
 *   PACT_RPC_URL       Solana RPC (use a Helius/Alchemy URL with an API key —
 *                      api.devnet/mainnet.solana.com rate-limit hard).
 * Optional env:
 *   PROGRAM_ID         defaults to the protocol-v1-client PROGRAM_ID constant
 *                      (currently the mainnet deploy). For devnet, set this to
 *                      your devnet deploy's program ID.
 *   USDC_MINT          defaults to USDC_MINT_DEVNET. Set to USDC_MINT_MAINNET
 *                      (= EPjFW...Dt1v) when running on mainnet (with --mainnet).
 *   POOL_VAULT_KEYPAIR path to a JSON keypair file used as the pool USDC vault
 *                      account on first register. Generated + written here if
 *                      absent. Default: ./scripts/.pay-default-pool-vault.json.
 *   SEED_USDC_LAMPORTS override the seed amount (default 25000000 = 25.00 USDC).
 *
 * Usage:
 *   # dry run, devnet (prints plan, sends nothing):
 *   PACT_PRIVATE_KEY=~/.config/solana/pact-devnet-authority.json \
 *   PACT_RPC_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   PROGRAM_ID=<devnet-program-id> USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
 *     pnpm exec tsx scripts/pay-default-bootstrap.ts
 *
 *   # for real, devnet:
 *   ... pnpm exec tsx scripts/pay-default-bootstrap.ts --confirm
 *
 *   # for real, MAINNET (the operator's expected path):
 *   PACT_PRIVATE_KEY=<protocol authority keypair> \
 *   PACT_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..." \
 *   PROGRAM_ID=<mainnet program id> USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
 *     pnpm exec tsx scripts/pay-default-bootstrap.ts --mainnet --confirm
 *
 *   # ...also seed the matching Postgres Endpoint row + reload the market-proxy:
 *   PG_URL=... pnpm --filter @pact-network/db exec tsx seeds/pay-default-endpoint.ts
 *   curl -X POST https://<market-proxy-host>/admin/reload-endpoints -H "Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN"
 *
 * Verify afterward:
 *   solana account <coveragePool PDA> --url $PACT_RPC_URL          # endpoint_slug = "pay-default", current_balance > 0
 *   solana account <endpointConfig PDA> --url $PACT_RPC_URL        # paused = 0, flat_premium_lamports = 1000
 *   curl -s https://facilitator.pact.network/.well-known/pay-coverage | jq
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
  USDC_MINT_MAINNET,
} from "@pact-network/protocol-v1-client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import bs58 from "bs58";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SLUG = "pay-default";
const FLAT_PREMIUM_LAMPORTS = 1_000n; // $0.001/call
const PERCENT_BPS = 0; // flat-only
const SLA_LATENCY_MS = 10_000; // 10s SLA (pay.sh calls are full HTTP round-trips; the CLI verdict is authoritative)
const IMPUTED_COST_LAMPORTS = 1_000_000n; // $1.00 per-call refund ceiling (refund = amount paid, capped at this)
const EXPOSURE_CAP_PER_HOUR_LAMPORTS = 5_000_000n; // $5.00/rolling hour — tight subsidised-launch float
const TREASURY_FEE_BPS = 1_000; // 10% → Treasury
const TOKEN_ACCOUNT_LEN = 165;
const DEFAULT_SEED_USDC_LAMPORTS = 25_000_000n; // 25.00 USDC
const DEFAULT_POOL_VAULT_KEYPAIR = resolvePath(
  process.cwd(),
  "scripts",
  ".pay-default-pool-vault.json",
);

const CONFIRM = process.argv.includes("--confirm");
const ALLOW_MAINNET = process.argv.includes("--mainnet");

// ---------------------------------------------------------------------------
// Keypair / env helpers
// ---------------------------------------------------------------------------
function expandTilde(p: string): string {
  return p.startsWith("~/") ? resolvePath(homedir(), p.slice(2)) : resolvePath(p);
}

function loadKeypairFromEnv(name: string): Keypair {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  if (raw.trim().startsWith("[") || existsSync(expandTilde(raw))) {
    const path = raw.trim().startsWith("[") ? null : expandTilde(raw);
    const json = path ? readFileSync(path, "utf8") : raw;
    const bytes = JSON.parse(json);
    if (!Array.isArray(bytes) || bytes.length !== 64) {
      throw new Error(`${name}: expected a 64-byte JSON array keypair`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
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

const MAINNET_USDC = USDC_MINT_MAINNET.toBase58();

function looksLikeMainnet(rpcUrl: string, usdcMint: PublicKey): boolean {
  return /mainnet/i.test(rpcUrl) || usdcMint.equals(USDC_MINT_MAINNET);
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

  const isMainnet = looksLikeMainnet(rpcUrl, usdcMint);

  console.log("=== Pact Network — pay-default coverage pool bootstrap ===");
  console.log(`  mode:               ${CONFIRM ? "REAL (txs will land)" : "DRY RUN (sends nothing — pass --confirm)"}`);
  console.log(`  network:            ${isMainnet ? "MAINNET" : "devnet/other"}${isMainnet ? (ALLOW_MAINNET ? " (--mainnet OK)" : " (BLOCKED — pass --mainnet)") : ""}`);
  console.log(`  RPC:                ${rpcUrl}`);
  console.log(`  program:            ${programId.toBase58()}`);
  console.log(`  USDC mint:          ${usdcMint.toBase58()}${usdcMint.equals(USDC_MINT_MAINNET) ? " (mainnet USDC)" : usdcMint.equals(USDC_MINT_DEVNET) ? " (devnet USDC)" : ""}`);
  console.log(`  authority:          ${authority.publicKey.toBase58()}`);
  console.log(`  authority USDC ATA: ${authorityUsdcAta.toBase58()}`);
  console.log(`  ProtocolConfig:     ${protocolConfigPda.toBase58()}`);
  console.log(`  Treasury PDA:       ${treasuryPda.toBase58()}`);
  console.log(`  EndpointConfig:     ${endpointConfigPda.toBase58()}  (slug="${SLUG}")`);
  console.log(`  CoveragePool:       ${coveragePoolPda.toBase58()}`);
  console.log(`  seed amount:        ${seedUsdc} (${(Number(seedUsdc) / 1e6).toFixed(6)} USDC)`);
  console.log(`  endpoint config:    flatPremium=${FLAT_PREMIUM_LAMPORTS} percentBps=${PERCENT_BPS} slaMs=${SLA_LATENCY_MS} imputed(refund ceiling)=${IMPUTED_COST_LAMPORTS} exposureCap/hr=${EXPOSURE_CAP_PER_HOUR_LAMPORTS} treasuryFeeBps=${TREASURY_FEE_BPS}`);
  console.log("");

  if (isMainnet && !ALLOW_MAINNET) {
    throw new Error(
      `Refusing to touch mainnet (RPC and/or USDC mint ${MAINNET_USDC} look like mainnet). ` +
        `This script DOES support mainnet — re-run with --mainnet to confirm you mean it. ` +
        `(Add --confirm too to actually send txs.)`,
    );
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
      // Single Treasury fee recipient — destination is substituted on-chain with
      // the canonical Treasury.usdc_vault; no AffiliateAta entries, so no extra
      // affiliateAtas accounts needed.
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
    console.log(`  solana account ${coveragePoolPda.toBase58()} --url ${rpcUrl}    # endpoint_slug "pay-default", current_balance > 0`);
    console.log(`  solana account ${endpointConfigPda.toBase58()} --url ${rpcUrl}  # paused=0, flat_premium_lamports=1000`);
    console.log("Then seed the matching Postgres row + reload the market-proxy:");
    console.log(`  PG_URL=... pnpm --filter @pact-network/db exec tsx seeds/pay-default-endpoint.ts`);
    console.log(`  curl -X POST https://<market-proxy-host>/admin/reload-endpoints -H "Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN"`);
  } else {
    console.log("Re-run with --confirm to actually register + fund. Add --mainnet if (and only if) you're on mainnet.");
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
