import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PactInsurance } from "../../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";

// Shared authority keypair used across all test files in the same mocha run.
// Generated once at module load so protocol.ts and pool.ts share it.
export const authority: Keypair = Keypair.generate();
export const treasury: PublicKey = Keypair.generate().publicKey;

let cachedUsdcMint: PublicKey | null = null;
let initialized = false;

export interface ProtocolHandles {
  protocolPda: PublicKey;
  authority: Keypair;
  treasury: PublicKey;
  usdcMint: PublicKey;
}

/**
 * Initialize the protocol PDA if it hasn't been initialized yet during this
 * mocha run. Returns the shared handles either way.
 *
 * Creates a real SPL mint so downstream tests (like create_pool) can use it
 * as a token mint for vault creation.
 */
export async function getOrInitProtocol(
  program: Program<PactInsurance>,
  provider: anchor.AnchorProvider
): Promise<ProtocolHandles> {
  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  if (!initialized) {
    // Fund the authority account so it can later pay for CreatePool (which
    // uses authority as the init payer for the pool + vault accounts).
    const airdropSig = await provider.connection.requestAirdrop(
      authority.publicKey,
      10_000_000_000 // 10 SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Check if the protocol PDA already exists on-chain (e.g. leftover from
    // a previous run on a persistent validator).
    const existing = await provider.connection.getAccountInfo(protocolPda);
    if (existing) {
      // Reuse the usdc_mint that was persisted in ProtocolConfig so the
      // existing protocol.ts assertion (config.usdcMint === usdcMint) still
      // holds. This path is only hit if someone is re-running tests against
      // a long-lived validator.
      const config = await program.account.protocolConfig.fetch(protocolPda);
      cachedUsdcMint = config.usdcMint;
    } else {
      // Create a real SPL USDC-like mint on the local validator.
      cachedUsdcMint = await createMint(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        provider.wallet.publicKey, // mint authority
        null,
        6 // decimals (USDC standard)
      );

      await program.methods
        .initializeProtocol({
          authority: authority.publicKey,
          treasury,
          usdcMint: cachedUsdcMint,
        })
        .accounts({
          config: protocolPda,
          deployer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    initialized = true;
  }

  return {
    protocolPda,
    authority,
    treasury,
    usdcMint: cachedUsdcMint!,
  };
}
