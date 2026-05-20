import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, statSync } from "node:fs";
import {
  FeeRecipientKind,
  type FeeRecipient,
} from "@q3labs/pact-protocol-v1-client";
import { createOperator } from "@q3labs/pact-operator-sdk";
import { resolveClusterConfig, type Cluster } from "../lib/solana.ts";
import { loadAuthorityKeypair } from "../lib/authority.ts";
import { mapOperatorError } from "./register.ts";
import type { Envelope } from "../lib/envelope.ts";

/** Wire shape of the --file JSON. */
interface RecipientSpec {
  kind: "Treasury" | "AffiliateAta";
  destination: string; // base58 pubkey
  bps: number;
}

/** Cap input file at 64 KB — at most 8 fee recipients on-chain, ~250 bytes each. */
const MAX_RECIPIENTS_FILE_BYTES = 64 * 1024;

export interface RecipientsCmdOpts {
  rpcUrl: string;
  cluster: Cluster;
  slug: string;
  file: string;
}

export async function recipientsCommand(
  opts: RecipientsCmdOpts,
): Promise<Envelope> {
  const cfg = resolveClusterConfig(opts.cluster);
  if ("error" in cfg) return { status: "client_error", body: { error: cfg.error } };

  let rawJson: string;
  try {
    const st = statSync(opts.file);
    if (st.size > MAX_RECIPIENTS_FILE_BYTES) {
      return {
        status: "client_error",
        body: {
          error: "recipients_file_too_large",
          message: `--file size ${st.size}B exceeds ${MAX_RECIPIENTS_FILE_BYTES}B cap`,
        },
      };
    }
    rawJson = readFileSync(opts.file, "utf8");
  } catch (err) {
    return {
      status: "client_error",
      body: {
        error: "recipients_file_missing",
        message: `cannot read --file ${opts.file}: ${(err as Error).message}`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      status: "client_error",
      body: {
        error: "recipients_file_invalid",
        message: `--file is not valid JSON: ${(err as Error).message}`,
      },
    };
  }

  const validation = validateRecipientsSpec(parsed);
  if ("error" in validation) {
    return {
      status: "client_error",
      body: { error: "recipients_file_invalid", message: validation.error },
    };
  }
  const { feeRecipients, affiliateAtas } = validation;

  const auth = loadAuthorityKeypair({ commandLabel: "pact recipients" });
  if ("error" in auth) return { status: "client_error", body: { error: auth.error } };

  const connection = new Connection(opts.rpcUrl, "confirmed");
  const operator = createOperator({
    connection,
    programId: cfg.programId,
    usdcMint: cfg.mint,
  });

  try {
    const result = await operator.updateFeeRecipients(auth, {
      slug: opts.slug,
      feeRecipients,
      affiliateAtas,
    });
    return {
      status: "ok",
      body: {
        action: "recipients",
        slug: opts.slug,
        count: feeRecipients.length,
        tx_signature: result.signature,
        confirmation_pending: false,
        cluster: opts.cluster,
      },
    };
  } catch (err) {
    return mapOperatorError(err, "recipients", opts.slug);
  }
}

function validateRecipientsSpec(
  parsed: unknown,
):
  | { feeRecipients: FeeRecipient[]; affiliateAtas: PublicKey[] }
  | { error: string } {
  if (!Array.isArray(parsed)) {
    return { error: "--file must contain a JSON array of recipient entries" };
  }
  if (parsed.length === 0) {
    return { error: "--file must contain at least one recipient entry" };
  }
  if (parsed.length > 8) {
    return { error: `at most 8 recipients allowed, got ${parsed.length}` };
  }
  const feeRecipients: FeeRecipient[] = [];
  const affiliateAtas: PublicKey[] = [];
  let totalBps = 0;
  let i = 0;
  for (const entry of parsed as RecipientSpec[]) {
    if (!entry || typeof entry !== "object") {
      return { error: `entry [${i}] must be an object` };
    }
    const { kind, destination, bps } = entry;
    if (kind !== "Treasury" && kind !== "AffiliateAta") {
      return { error: `entry [${i}].kind must be 'Treasury' or 'AffiliateAta', got '${kind}'` };
    }
    if (typeof destination !== "string") {
      return { error: `entry [${i}].destination must be a base58 pubkey string` };
    }
    let destPubkey: PublicKey;
    try {
      destPubkey = new PublicKey(destination);
    } catch {
      return { error: `entry [${i}].destination is not a valid base58 pubkey: ${destination}` };
    }
    if (typeof bps !== "number" || !Number.isFinite(bps) || bps < 0 || bps > 10000 || !Number.isInteger(bps)) {
      return { error: `entry [${i}].bps must be an integer in [0, 10000], got ${bps}` };
    }
    totalBps += bps;
    feeRecipients.push({
      kind: kind === "Treasury" ? FeeRecipientKind.Treasury : FeeRecipientKind.AffiliateAta,
      destination,
      bps,
    });
    if (kind === "AffiliateAta") {
      affiliateAtas.push(destPubkey);
    }
    i += 1;
  }
  if (totalBps > 10000) {
    return { error: `sum of bps (${totalBps}) exceeds 10000` };
  }
  return { feeRecipients, affiliateAtas };
}
