import { Connection } from "@solana/web3.js";
import {
  getEndpointConfigPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { createOperator } from "@q3labs/pact-operator-sdk";
import { resolveClusterConfig, type Cluster } from "../lib/solana.ts";
import { loadAuthorityKeypair } from "../lib/authority.ts";
import { mapOperatorError } from "./register.ts";
import type { Envelope } from "../lib/envelope.ts";

export interface PauseEndpointCmdOpts {
  rpcUrl: string;
  cluster: Cluster;
  slug: string;
  paused: boolean;
}

export async function pauseEndpointCommand(
  opts: PauseEndpointCmdOpts,
): Promise<Envelope> {
  const cfg = resolveClusterConfig(opts.cluster);
  if ("error" in cfg) return { status: "client_error", body: { error: cfg.error } };

  const auth = loadAuthorityKeypair({ commandLabel: "pact pause-endpoint" });
  if ("error" in auth) return { status: "client_error", body: { error: auth.error } };

  const connection = new Connection(opts.rpcUrl, "confirmed");
  const operator = createOperator({
    connection,
    programId: cfg.programId,
    usdcMint: cfg.mint,
  });

  try {
    const result = await operator.pauseEndpoint(auth, {
      slug: opts.slug,
      paused: opts.paused,
    });
    const [endpointConfigPda] = getEndpointConfigPda(
      cfg.programId,
      slugBytes(opts.slug),
    );
    return {
      status: "ok",
      body: {
        action: "pause-endpoint",
        slug: opts.slug,
        paused: opts.paused,
        tx_signature: result.signature,
        confirmation_pending: false,
        endpoint_config_pda: endpointConfigPda.toBase58(),
        cluster: opts.cluster,
      },
    };
  } catch (err) {
    return mapOperatorError(err, "pause-endpoint", opts.slug);
  }
}
