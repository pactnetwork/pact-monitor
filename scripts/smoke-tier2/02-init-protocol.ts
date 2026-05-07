/**
 * 02-init-protocol.ts — fires the 8 protocol init instructions:
 *   1. initialize_protocol_config (no fee recipients on the protocol default)
 *   2. initialize_treasury (allocates the Treasury USDC vault account first)
 *   3. initialize_settlement_authority
 *   4..8. register_endpoint × 5 (one per slug in ENDPOINTS)
 *
 * Each register_endpoint also pre-allocates a per-endpoint pool USDC vault
 * (the on-chain handler binds it via InitializeAccount3). We supply each
 * endpoint a single Treasury fee recipient at 100 bps (1%) so settle_batch
 * tx can exercise fee-fan-out on the Treasury kind.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  Keypair,
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
} from "@pact-network/protocol-v1-client";

import {
  ENDPOINTS,
  POOL_VAULT_KEYPAIR,
  PROGRAM_KEYPAIR,
  PROTOCOL_AUTHORITY_KEYPAIR,
  SETTLEMENT_AUTHORITY_KEYPAIR,
  SMOKE_RPC_URL,
  TREASURY_VAULT_KEYPAIR,
  USDC_DEVNET_MINT,
} from "./lib/paths";
import { readKeypair } from "./lib/keys";
import { patchState } from "./lib/state";

const TOKEN_ACCOUNT_LEN = 165;

async function ensureFunded(conn: Connection, pubkey: PublicKey, sol = 5) {
  const bal = await conn.getBalance(pubkey, "confirmed");
  if (bal < sol * 1e9 / 2) {
    const sig = await conn.requestAirdrop(pubkey, sol * 1e9);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`  airdrop ${sol} SOL → ${pubkey.toBase58()} (sig=${sig.slice(0, 8)}…)`);
  }
}

async function main() {
  const conn = new Connection(SMOKE_RPC_URL, "confirmed");
  const program = readKeypair(PROGRAM_KEYPAIR);
  const programId = program.publicKey;
  const auth = readKeypair(PROTOCOL_AUTHORITY_KEYPAIR);
  const settler = readKeypair(SETTLEMENT_AUTHORITY_KEYPAIR);
  const treasuryVault = readKeypair(TREASURY_VAULT_KEYPAIR);
  const usdcMint = new PublicKey(USDC_DEVNET_MINT);

  console.log(`Program ID: ${programId.toBase58()}`);
  console.log(`Authority:  ${auth.publicKey.toBase58()}`);

  await ensureFunded(conn, auth.publicKey, 10);
  await ensureFunded(conn, settler.publicKey, 5);

  const sigs: Record<string, string> = {};

  // ----- 1. initialize_protocol_config -----
  const [protocolConfigPda] = getProtocolConfigPda(programId);
  console.log(`\n[1/8] initialize_protocol_config — PDA ${protocolConfigPda.toBase58()}`);
  {
    const ix = buildInitializeProtocolConfigIx({
      programId,
      authority: auth.publicKey,
      protocolConfig: protocolConfigPda,
      usdcMint,
      defaultFeeRecipients: [], // no protocol-default; per-endpoint instead
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" });
    console.log(`  sig: ${sig}`);
    sigs.initializeProtocolConfig = sig;
  }

  // ----- 2. initialize_treasury -----
  const [treasuryPda] = getTreasuryPda(programId);
  console.log(`\n[2/8] initialize_treasury — PDA ${treasuryPda.toBase58()}, vault ${treasuryVault.publicKey.toBase58()}`);
  {
    // Pre-allocate the 165-byte token account, owner = SPL Token program.
    const rentLamports = await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
    const createIx = SystemProgram.createAccount({
      fromPubkey: auth.publicKey,
      newAccountPubkey: treasuryVault.publicKey,
      lamports: rentLamports,
      space: TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    });
    const initIx = buildInitializeTreasuryIx({
      programId,
      authority: auth.publicKey,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      treasuryVault: treasuryVault.publicKey,
      usdcMint,
    });
    const tx = new Transaction().add(createIx).add(initIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [auth, treasuryVault], { commitment: "confirmed" });
    console.log(`  sig: ${sig}`);
    sigs.initializeTreasury = sig;
  }

  // ----- 3. initialize_settlement_authority -----
  const [saPda] = getSettlementAuthorityPda(programId);
  console.log(`\n[3/8] initialize_settlement_authority — PDA ${saPda.toBase58()}, signer ${settler.publicKey.toBase58()}`);
  {
    const ix = buildInitializeSettlementAuthorityIx({
      programId,
      authority: auth.publicKey,
      protocolConfig: protocolConfigPda,
      settlementAuthority: saPda,
      settlerSigner: settler.publicKey,
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" });
    console.log(`  sig: ${sig}`);
    sigs.initializeSettlementAuthority = sig;
  }

  // ----- 4..8. register_endpoint × 5 -----
  const endpointSnapshots: Array<{
    slug: string;
    endpointConfigPda: string;
    coveragePool: string;
    poolVault: string;
  }> = [];
  let step = 4;
  for (const ep of ENDPOINTS) {
    const slug = slugBytes(ep.slug);
    const [endpointConfigPda] = getEndpointConfigPda(programId, slug);
    const [coveragePool] = getCoveragePoolPda(programId, slug);
    const poolVault = readKeypair(POOL_VAULT_KEYPAIR(ep.slug));

    console.log(
      `\n[${step}/8] register_endpoint("${ep.slug}") — endpoint ${endpointConfigPda
        .toBase58()
        .slice(0, 8)}…, pool ${coveragePool.toBase58().slice(0, 8)}…, vault ${poolVault.publicKey
        .toBase58()
        .slice(0, 8)}…`,
    );
    const rentLamports = await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
    const createIx = SystemProgram.createAccount({
      fromPubkey: auth.publicKey,
      newAccountPubkey: poolVault.publicKey,
      lamports: rentLamports,
      space: TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    });
    const regIx = buildRegisterEndpointIx({
      programId,
      authority: auth.publicKey,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      endpointConfig: endpointConfigPda,
      coveragePool,
      poolVault: poolVault.publicKey,
      usdcMint,
      slug,
      flatPremiumLamports: ep.flatPremium,
      percentBps: ep.percentBps,
      slaLatencyMs: ep.sla,
      imputedCostLamports: 10_000n,
      exposureCapPerHourLamports: 100_000_000n,
      // Override fee recipients with single Treasury entry at 100bps (1%).
      feeRecipients: [
        {
          kind: FeeRecipientKind.Treasury,
          destination: treasuryPda.toBase58(),
          bps: 100,
        },
      ],
      feeRecipientCount: 1,
    });
    const tx = new Transaction().add(createIx).add(regIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [auth, poolVault], {
      commitment: "confirmed",
    });
    console.log(`  sig: ${sig}`);
    sigs[`registerEndpoint:${ep.slug}`] = sig;

    endpointSnapshots.push({
      slug: ep.slug,
      endpointConfigPda: endpointConfigPda.toBase58(),
      coveragePool: coveragePool.toBase58(),
      poolVault: poolVault.publicKey.toBase58(),
    });
    step++;
  }

  patchState({
    protocolConfigPda: protocolConfigPda.toBase58(),
    treasuryPda: treasuryPda.toBase58(),
    treasuryVault: treasuryVault.publicKey.toBase58(),
    settlementAuthorityPda: saPda.toBase58(),
    endpoints: endpointSnapshots,
    signatures: sigs,
  });

  console.log("\n== smoke-tier2/02-init-protocol OK ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
