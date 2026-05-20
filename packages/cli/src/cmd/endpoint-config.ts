import { Connection } from "@solana/web3.js";
import { createOperator } from "@q3labs/pact-operator-sdk";
import { resolveClusterConfig, type Cluster } from "../lib/solana.ts";
import { loadAuthorityKeypair } from "../lib/authority.ts";
import { mapOperatorError } from "./register.ts";
import type { Envelope } from "../lib/envelope.ts";

export interface EndpointConfigCmdOpts {
  rpcUrl: string;
  cluster: Cluster;
  slug: string;
  flatPremiumLamports?: bigint;
  percentBps?: number;
  slaLatencyMs?: number;
  imputedCostLamports?: bigint;
  exposureCapPerHourLamports?: bigint;
}

export async function endpointConfigCommand(
  opts: EndpointConfigCmdOpts,
): Promise<Envelope> {
  const cfg = resolveClusterConfig(opts.cluster);
  if ("error" in cfg) return { status: "client_error", body: { error: cfg.error } };

  // Reject empty updates client-side — the on-chain ix would otherwise touch
  // no fields and waste a tx fee.
  const updatedFields: string[] = [];
  if (opts.flatPremiumLamports !== undefined) updatedFields.push("flat_premium_lamports");
  if (opts.percentBps !== undefined) updatedFields.push("percent_bps");
  if (opts.slaLatencyMs !== undefined) updatedFields.push("sla_latency_ms");
  if (opts.imputedCostLamports !== undefined) updatedFields.push("imputed_cost_lamports");
  if (opts.exposureCapPerHourLamports !== undefined) updatedFields.push("exposure_cap_per_hour_lamports");
  if (updatedFields.length === 0) {
    return {
      status: "client_error",
      body: {
        error: "no_fields",
        message:
          "supply at least one of --flat-premium, --percent-bps, --sla-ms, --imputed-cost, --exposure-cap",
      },
    };
  }

  const auth = loadAuthorityKeypair({ commandLabel: "pact endpoint-config" });
  if ("error" in auth) return { status: "client_error", body: { error: auth.error } };

  const connection = new Connection(opts.rpcUrl, "confirmed");
  const operator = createOperator({
    connection,
    programId: cfg.programId,
    usdcMint: cfg.mint,
  });

  try {
    const result = await operator.updateEndpointConfig(auth, {
      slug: opts.slug,
      flatPremiumLamports: opts.flatPremiumLamports,
      percentBps: opts.percentBps,
      slaLatencyMs: opts.slaLatencyMs,
      imputedCostLamports: opts.imputedCostLamports,
      exposureCapPerHourLamports: opts.exposureCapPerHourLamports,
    });
    return {
      status: "ok",
      body: {
        action: "endpoint-config",
        slug: opts.slug,
        updated_fields: updatedFields,
        tx_signature: result.signature,
        confirmation_pending: false,
        cluster: opts.cluster,
      },
    };
  } catch (err) {
    return mapOperatorError(err, "endpoint-config", opts.slug);
  }
}
