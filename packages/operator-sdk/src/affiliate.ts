/**
 * @q3labs/pact-operator-sdk/affiliate — read-only earnings observability.
 *
 * Affiliates are fee recipients (`AffiliateAta` / `Treasury`) configured on
 * the on-chain `EndpointConfig.fee_recipients` array. They earn passively
 * via `settle_batch`'s fee fan-out — there is no withdraw, no signing,
 * nothing to claim. The SDK is read-only by construction (the factory
 * takes a `PublicKey`, not a signer).
 *
 * Backed by two indexer routes (added in C2):
 *   GET /api/recipients/:pubkey                 — lifetime aggregates
 *   GET /api/recipients/:pubkey/settlements     — cursor-paginated history
 */
import { PublicKey } from "@solana/web3.js";
import {
  getJson,
  type AffiliateClientOpts,
  type RecipientEarningsWire,
  type RecipientSettlementsPage,
} from "./reads/affiliate-client.js";

export interface AffiliateInstance {
  /** The affiliate's pubkey (echo). */
  readonly pubkey: PublicKey;

  /**
   * Lifetime earnings aggregate. Returns a zero envelope (NOT 404) when
   * the pubkey has never received a fee share — a legitimate state.
   */
  lifetimeEarnings(): Promise<RecipientEarningsWire>;

  /**
   * Reverse-chronological paginated settlement history. Cursor is opaque;
   * pass `result.nextCursor` from the previous call to advance. `null`
   * `nextCursor` means there are no more pages.
   *
   * @param opts.limit  default 50, clamped server-side to [1, 200].
   * @param opts.cursor opaque cursor from a previous response; omit for first page.
   */
  recentSettlements(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<RecipientSettlementsPage>;
}

export function createAffiliate(
  pubkey: PublicKey,
  opts: AffiliateClientOpts,
): AffiliateInstance {
  const pk = pubkey.toBase58();
  return {
    pubkey,
    lifetimeEarnings: () =>
      getJson<RecipientEarningsWire>(opts, `/api/recipients/${pk}`),
    recentSettlements: (q) => {
      const params = new URLSearchParams();
      if (q?.limit !== undefined) params.set("limit", String(q.limit));
      if (q?.cursor !== undefined) params.set("cursor", q.cursor);
      const qs = params.toString();
      return getJson<RecipientSettlementsPage>(
        opts,
        `/api/recipients/${pk}/settlements${qs ? `?${qs}` : ""}`,
      );
    },
  };
}

export type {
  AffiliateClientOpts,
  RecipientEarningsWire,
  RecipientSettlementsPage,
  RecipientSettlementItem,
} from "./reads/affiliate-client.js";
