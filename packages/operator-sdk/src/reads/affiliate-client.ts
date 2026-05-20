import { OperatorError, OperatorErrorCode } from "../errors.js";

/**
 * One-shot fetch wrapper for the indexer's read API. Mirrors the 15-line
 * idiom from `@q3labs/pact-sdk`'s `indexer-poller.ts:flush()` (fetch +
 * validateStatus + JSON parse) — does NOT inherit the stateful poller
 * class shape (start/stop/observation-buffer reconciliation are agent-side
 * concerns, irrelevant here).
 *
 * Throws `OperatorError.AFFILIATE_READ_FAILED` on non-2xx, network, or
 * parse errors. Never throws on a 200 with an empty envelope — that's a
 * legitimate "no earnings yet" state.
 */
export interface AffiliateClientOpts {
  /** Indexer base URL, no trailing slash. e.g. https://indexer.pactnetwork.io */
  indexerBaseUrl: string;
  /** Optional fetch override (testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 10_000. */
  timeoutMs?: number;
}

export async function getJson<T>(
  opts: AffiliateClientOpts,
  path: string,
): Promise<T> {
  const url = `${opts.indexerBaseUrl.replace(/\/+$/, "")}${path}`;
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetchFn(url, { signal: ac.signal });
  } catch (cause) {
    throw new OperatorError(
      OperatorErrorCode.AFFILIATE_READ_FAILED,
      `affiliate read GET ${url} failed: network error`,
      { cause },
    );
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    throw new OperatorError(
      OperatorErrorCode.AFFILIATE_READ_FAILED,
      `affiliate read GET ${url} returned ${res.status}`,
      { details: { status: res.status, statusText: res.statusText, url } },
    );
  }
  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new OperatorError(
      OperatorErrorCode.AFFILIATE_READ_FAILED,
      `affiliate read GET ${url} returned malformed JSON`,
      { cause },
    );
  }
}

/** Wire shape of GET /api/recipients/:pubkey. */
export interface RecipientEarningsWire {
  recipientPubkey: string;
  recipientKind: number | null;
  lifetimeEarnedLamports: string;
  lastUpdated: string | null;
}

/** One row in the paginated settlements response. */
export interface RecipientSettlementItem {
  id: string;
  settledAt: string;
  txSignature: string;
  amountLamports: string;
  recipientKind: number;
}

/** Wire shape of GET /api/recipients/:pubkey/settlements. */
export interface RecipientSettlementsPage {
  items: RecipientSettlementItem[];
  nextCursor: string | null;
}
