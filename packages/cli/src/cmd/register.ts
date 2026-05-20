import { Connection, Keypair } from "@solana/web3.js";
import {
  getEndpointConfigPda,
  getCoveragePoolPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import {
  createOperator,
  OperatorError,
  OperatorErrorCode,
} from "@q3labs/pact-operator-sdk";
import { resolveClusterConfig, type Cluster } from "../lib/solana.ts";
import { loadAuthorityKeypair } from "../lib/authority.ts";
import type { Envelope } from "../lib/envelope.ts";

export interface RegisterCmdOpts {
  rpcUrl: string;
  cluster: Cluster;
  slug: string;
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
}

export async function registerCommand(
  opts: RegisterCmdOpts,
): Promise<Envelope> {
  const cfg = resolveClusterConfig(opts.cluster);
  if ("error" in cfg) return { status: "client_error", body: { error: cfg.error } };

  const auth = loadAuthorityKeypair({ commandLabel: "pact register" });
  if ("error" in auth) return { status: "client_error", body: { error: auth.error } };

  const poolVault = Keypair.generate();
  const connection = new Connection(opts.rpcUrl, "confirmed");
  const operator = createOperator({
    connection,
    programId: cfg.programId,
    usdcMint: cfg.mint,
  });

  try {
    const result = await operator.registerEndpoint(auth, poolVault, {
      slug: opts.slug,
      flatPremiumLamports: opts.flatPremiumLamports,
      percentBps: opts.percentBps,
      slaLatencyMs: opts.slaLatencyMs,
      imputedCostLamports: opts.imputedCostLamports,
      exposureCapPerHourLamports: opts.exposureCapPerHourLamports,
      poolVault: poolVault.publicKey,
    });
    const slug = slugBytes(opts.slug);
    const [endpointConfigPda] = getEndpointConfigPda(cfg.programId, slug);
    const [coveragePoolPda] = getCoveragePoolPda(cfg.programId, slug);
    return {
      status: "ok",
      body: {
        action: "register",
        slug: opts.slug,
        tx_signature: result.signature,
        confirmation_pending: false,
        endpoint_config_pda: endpointConfigPda.toBase58(),
        coverage_pool_pda: coveragePoolPda.toBase58(),
        pool_vault_pubkey: poolVault.publicKey.toBase58(),
        cluster: opts.cluster,
      },
    };
  } catch (err) {
    return mapOperatorError(err, "register", opts.slug);
  }
}

function mapOperatorError(err: unknown, action: string, slug: string): Envelope {
  if (err instanceof OperatorError) {
    switch (err.code) {
      case OperatorErrorCode.ENDPOINT_ALREADY_REGISTERED:
        return {
          status: "already_registered",
          body: {
            action,
            slug,
            error: err.message,
            ...err.details,
          },
        };
      case OperatorErrorCode.AUTHORITY_MISMATCH:
      case OperatorErrorCode.POOL_AUTHORITY_MISMATCH:
        return {
          status: "signature_rejected",
          body: { action, slug, error: err.message, ...err.details },
        };
      case OperatorErrorCode.SIMULATION_FAILED:
      case OperatorErrorCode.BLOCK_HEIGHT_EXCEEDED:
      case OperatorErrorCode.RPC_ERROR:
        return {
          status: "server_error",
          body: { action, slug, error: err.message, ...err.details },
        };
      case OperatorErrorCode.CONFIG_INVALID:
        return {
          status: "client_error",
          body: { action, slug, error: err.message },
        };
    }
  }
  return {
    status: "cli_internal_error",
    body: { action, slug, error: (err as Error).message ?? String(err) },
  };
}

export { mapOperatorError };
