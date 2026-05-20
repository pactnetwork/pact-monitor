import { PublicKey } from "@solana/web3.js";
import {
  OperatorError,
  OperatorErrorCode,
} from "@q3labs/pact-operator-sdk";
import { createAffiliate } from "@q3labs/pact-operator-sdk/affiliate";
import type { Envelope } from "../lib/envelope.ts";

const DEFAULT_INDEXER = "https://indexer.pactnetwork.io";

export interface EarningsCmdOpts {
  /** base58 pubkey (already coerced by validators.parsePubkeyStrict). */
  pubkey: string;
  history: boolean;
  limit?: number;
  cursor?: string;
  /** Indexer base URL override; defaults to PACT_INDEXER_URL or production. */
  indexerBaseUrl?: string;
}

export async function earningsCommand(
  opts: EarningsCmdOpts,
): Promise<Envelope> {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(opts.pubkey);
  } catch {
    return {
      status: "client_error",
      body: {
        error: "invalid_pubkey",
        message: `'${opts.pubkey}' is not a base58 32-byte pubkey`,
      },
    };
  }
  const indexerBaseUrl =
    opts.indexerBaseUrl ?? process.env.PACT_INDEXER_URL ?? DEFAULT_INDEXER;
  const affiliate = createAffiliate(pubkey, { indexerBaseUrl });

  try {
    const lifetime = await affiliate.lifetimeEarnings();
    let history: { items: unknown[]; next_cursor: string | null } | undefined;
    if (opts.history) {
      const page = await affiliate.recentSettlements({
        limit: opts.limit,
        cursor: opts.cursor,
      });
      history = { items: page.items, next_cursor: page.nextCursor };
    }
    return {
      status: "ok",
      body: {
        action: "earnings",
        affiliate: pubkey.toBase58(),
        lifetime: {
          lifetime_earned_lamports: lifetime.lifetimeEarnedLamports,
          recipient_kind: lifetime.recipientKind,
          last_updated: lifetime.lastUpdated,
        },
        ...(history ? { history } : {}),
        indexer: indexerBaseUrl,
      },
    };
  } catch (err) {
    if (
      err instanceof OperatorError &&
      err.code === OperatorErrorCode.AFFILIATE_READ_FAILED
    ) {
      return {
        status: "indexer_unreachable",
        body: {
          action: "earnings",
          affiliate: pubkey.toBase58(),
          indexer: indexerBaseUrl,
          error: err.message,
          ...err.details,
        },
      };
    }
    return {
      status: "cli_internal_error",
      body: { error: (err as Error).message ?? String(err) },
    };
  }
}
