import { Connection } from "@solana/web3.js";
import {
  decodeCoveragePool,
  getCoveragePoolPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { createOperator } from "@q3labs/pact-operator-sdk";
import { resolveClusterConfig, type Cluster } from "../lib/solana.ts";
import { loadAuthorityKeypair } from "../lib/authority.ts";
import { mapOperatorError } from "./register.ts";
import type { Envelope } from "../lib/envelope.ts";

export interface TopupCmdOpts {
  rpcUrl: string;
  cluster: Cluster;
  slug: string;
  /** Decimal USDC amount (will be converted to base units ×1_000_000). */
  amountUsdc: number;
}

export async function topupCommand(opts: TopupCmdOpts): Promise<Envelope> {
  const cfg = resolveClusterConfig(opts.cluster);
  if ("error" in cfg) return { status: "client_error", body: { error: cfg.error } };

  // Pool authority is a DIFFERENT role than ProtocolConfig.authority.
  // Require explicit PACT_POOL_AUTHORITY_KEY env so an operator can't
  // accidentally try to topup with the protocol authority and get a
  // confusing on-chain POOL_AUTHORITY_MISMATCH after burning an RPC call.
  const auth = loadAuthorityKeypair({
    envVar: "PACT_POOL_AUTHORITY_KEY",
    commandLabel: "pact topup",
  });
  if ("error" in auth) return { status: "client_error", body: { error: auth.error } };

  const connection = new Connection(opts.rpcUrl, "confirmed");
  const operator = createOperator({
    connection,
    programId: cfg.programId,
    usdcMint: cfg.mint,
  });

  const amountBaseUnits = BigInt(Math.round(opts.amountUsdc * 1_000_000));
  if (amountBaseUnits <= 0n) {
    return {
      status: "client_error",
      body: {
        error: "amount_invalid",
        message: `amount ${opts.amountUsdc} USDC rounds to <= 0 base units`,
      },
    };
  }

  // Caller's USDC ATA — derive deterministically (ATA program).
  const slug = slugBytes(opts.slug);
  const [coveragePoolPda] = getCoveragePoolPda(cfg.programId, slug);

  // We need both authorityAta and poolVault from on-chain CoveragePool.
  let info;
  try {
    info = await connection.getAccountInfo(coveragePoolPda, "confirmed");
  } catch (err) {
    return {
      status: "server_error",
      body: { action: "topup", slug: opts.slug, error: (err as Error).message },
    };
  }
  if (!info) {
    return {
      status: "client_error",
      body: {
        action: "topup",
        slug: opts.slug,
        error: "endpoint_not_registered",
        message: `coverage pool ${coveragePoolPda.toBase58()} not found — register the slug first`,
      },
    };
  }
  const pool = decodeCoveragePool(info.data);
  const { PublicKey } = await import("@solana/web3.js");
  const poolVault = new PublicKey(pool.usdcVault as never);
  const authorityAta = deriveAta(cfg.mint, auth.publicKey, PublicKey);

  try {
    const result = await operator.topUpCoveragePool(auth, {
      slug: opts.slug,
      amount: amountBaseUnits,
      authorityAta,
      poolVault,
    });
    return {
      status: "ok",
      body: {
        action: "topup",
        slug: opts.slug,
        amount_usdc: opts.amountUsdc,
        amount_base_units: amountBaseUnits.toString(),
        tx_signature: result.signature,
        confirmation_pending: false,
        coverage_pool_pda: coveragePoolPda.toBase58(),
        cluster: opts.cluster,
      },
    };
  } catch (err) {
    return mapOperatorError(err, "topup", opts.slug);
  }
}

function deriveAta(
  mint: import("@solana/web3.js").PublicKey,
  owner: import("@solana/web3.js").PublicKey,
  PublicKey: typeof import("@solana/web3.js").PublicKey,
): import("@solana/web3.js").PublicKey {
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}
