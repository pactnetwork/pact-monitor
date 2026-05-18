/**
 * GoldRush settlement-verification gate for claim adjudication.
 *
 * Additive verification layer. When an agent files a refund claim, we ask
 * GoldRush whether the upstream x402 settlement tx actually happened with
 * matching sender/recipient/amount. The answer is advisory metadata on the
 * claim row — not a hard gate. Existing trust-the-agent + on-chain caps
 * stay authoritative.
 *
 * Failure modes that MUST NOT block claim processing:
 *   - GoldRush down, slow, or rate-limited (3s timeout + 1 retry, then bail)
 *   - GoldRush stale relative to chain (5–30s indexing lag is normal)
 *   - Pact's call_records row missing the upstream tx signature
 *
 * In all of the above the verifier returns { result: "unavailable", ... } and
 * adjudication proceeds on existing logic. This is the "golden rule extended"
 * from the brief: GoldRush down OR stale OR rate-limited = Pact still works.
 *
 * Why this lives in backend/ and not in market-proxy/ or settler/:
 *   The legacy V2 scorecard backend is where /api/v1/claims/submit currently
 *   adjudicates. Once V1 mainnet flow folds claim adjudication into
 *   settler+indexer (post-multisig), this module ports cleanly to either —
 *   the public API is intentionally framework-free (no Fastify, no NestJS).
 */

export type VerificationResult =
  | "match"
  | "mismatch"
  | "unavailable"
  | "stale"
  | "skipped";

export interface VerificationInput {
  /** Upstream x402 settlement tx signature from call_records.tx_hash. */
  txSignature: string | null;
  /** Agent's Solana pubkey (base58). The expected sender. */
  agentPubkey: string;
  /** Provider's payment recipient pubkey (base58). */
  recipientAddress: string | null;
  /** Amount agent paid upstream in base units (USDC = 6 decimals). */
  expectedAmount: number | null;
  /** When the call happened, used to bound staleness. */
  callTimestamp: Date;
}

export interface VerificationDetail {
  result: VerificationResult;
  /** Free-form one-line reason, safe to log. */
  reason: string;
  /** Round-trip latency to GoldRush in ms (null when no call was made). */
  latencyMs: number | null;
  /** Internal confidence band: high / medium / low / none. */
  confidence: "high" | "medium" | "low" | "none";
  /** True if served from the in-memory dedupe cache. */
  cacheHit: boolean;
}

export interface GoldRushClient {
  fetchTransaction(txSig: string, signal: AbortSignal): Promise<GoldRushTxResponse | null>;
}

/**
 * Subset of the GoldRush Solana transaction response we actually read.
 * The full payload is much larger; we deliberately pin only fields used by
 * verification so a Covalent schema drift doesn't crash claim adjudication.
 *
 * Source of truth: https://goldrush.dev/docs (Solana endpoints). The exact
 * path varies between v2 (legacy class-based) and v3 (REST) — the client
 * below uses the documented Solana onchain-data REST shape with a base URL
 * pinned via env so we can rev it without code changes.
 */
export interface GoldRushTxResponse {
  signature: string;
  /** Block time as ISO string or unix seconds — we accept both. */
  blockTime: string | number | null;
  /** SOL/token transfers attached to this tx, simplified. */
  transfers: Array<{
    fromAddress: string;
    toAddress: string;
    amount: string | number;
    /** Token mint (or "native" for SOL). USDC mint expected here. */
    tokenAddress?: string;
  }>;
}

/**
 * Realistic per-claim multiplier from the brief: 1× nominal, 2–3× with
 * pagination + retries + read-after-write lag. We model this as: 1 lookup +
 * up to 1 retry on transient failure, then bail to unavailable.
 */
const TIMEOUT_MS = 3_000;
const MAX_ATTEMPTS = 2;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_INGESTION_LAG_MS = 90_000; // anything older than this is "stale"
const AMOUNT_TOLERANCE_BPS = 100; // 1% — covers priority-fee deduction
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface CacheValue {
  detail: VerificationDetail;
  expiresAt: number;
}

const cache = new Map<string, CacheValue>();

function dedupeKey(input: VerificationInput): string {
  return [
    input.agentPubkey,
    input.recipientAddress ?? "_",
    input.expectedAmount ?? 0,
    Math.floor(input.callTimestamp.getTime() / 1000),
  ].join("|");
}

function gc(): void {
  if (cache.size < 1024) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}

export function parseBlockTime(bt: GoldRushTxResponse["blockTime"]): Date | null {
  if (bt == null) return null;
  if (typeof bt === "number") {
    // Unix seconds, not ms — Solana RPC convention.
    return new Date(bt * 1000);
  }
  const d = new Date(bt);
  return isNaN(d.getTime()) ? null : d;
}

export function compareAmount(
  observed: number,
  expected: number,
  toleranceBps = AMOUNT_TOLERANCE_BPS,
): boolean {
  if (expected <= 0) return observed === 0;
  const tolerance = (expected * toleranceBps) / 10_000;
  return Math.abs(observed - expected) <= tolerance;
}

/**
 * Pure verification given a fetched GoldRush response. Split out from the
 * fetching path so unit tests don't need to mock HTTP.
 */
export function evaluate(
  input: VerificationInput,
  tx: GoldRushTxResponse,
): VerificationDetail {
  const blockTime = parseBlockTime(tx.blockTime);
  if (blockTime) {
    const lag = Date.now() - blockTime.getTime();
    if (
      lag > MAX_INGESTION_LAG_MS &&
      Math.abs(blockTime.getTime() - input.callTimestamp.getTime()) > MAX_INGESTION_LAG_MS
    ) {
      // Tx exists but its block time and the claim's call time are too far
      // apart to be the same call. Treat as stale rather than mismatch so
      // adjudication can retry later and the agent doesn't get rejected
      // because of indexer lag.
      return {
        result: "stale",
        reason: `GoldRush blockTime ${blockTime.toISOString()} >${MAX_INGESTION_LAG_MS}ms from claim timestamp`,
        latencyMs: null,
        confidence: "low",
        cacheHit: false,
      };
    }
  }

  const usdcTransfers = tx.transfers.filter(
    (t) => !t.tokenAddress || t.tokenAddress === USDC_MINT_MAINNET,
  );

  const fromOk = usdcTransfers.some(
    (t) => t.fromAddress === input.agentPubkey,
  );
  if (!fromOk) {
    return {
      result: "mismatch",
      reason: `GoldRush tx has no transfer from agent ${input.agentPubkey}`,
      latencyMs: null,
      confidence: "high",
      cacheHit: false,
    };
  }

  if (input.recipientAddress) {
    const toOk = usdcTransfers.some(
      (t) =>
        t.fromAddress === input.agentPubkey &&
        t.toAddress === input.recipientAddress,
    );
    if (!toOk) {
      return {
        result: "mismatch",
        reason: `No agent→${input.recipientAddress} transfer in tx`,
        latencyMs: null,
        confidence: "high",
        cacheHit: false,
      };
    }
  }

  if (input.expectedAmount != null && input.expectedAmount > 0) {
    const matched = usdcTransfers.some((t) => {
      const observed = typeof t.amount === "number" ? t.amount : Number(t.amount);
      if (!Number.isFinite(observed)) return false;
      return (
        t.fromAddress === input.agentPubkey &&
        compareAmount(observed, input.expectedAmount as number)
      );
    });
    if (!matched) {
      return {
        result: "mismatch",
        reason: `No transfer matching expected amount ${input.expectedAmount} within ${AMOUNT_TOLERANCE_BPS}bps`,
        latencyMs: null,
        confidence: "medium",
        cacheHit: false,
      };
    }
  }

  return {
    result: "match",
    reason: "sender, recipient, and amount match GoldRush record",
    latencyMs: null,
    confidence: input.recipientAddress && input.expectedAmount ? "high" : "medium",
    cacheHit: false,
  };
}

/**
 * The default REST client. Reads GOLDRUSH_API_KEY and (optionally)
 * GOLDRUSH_BASE_URL. Returns null when GoldRush has no record of the tx.
 *
 * Uses Node 18+ global fetch — no extra dep required.
 */
export function createDefaultClient(): GoldRushClient | null {
  const apiKey = process.env.GOLDRUSH_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.GOLDRUSH_BASE_URL ?? "https://api.covalenthq.com/v1").replace(/\/+$/, "");

  return {
    async fetchTransaction(txSig, signal) {
      const url = `${baseUrl}/solana-mainnet/transaction/${encodeURIComponent(txSig)}/`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          "user-agent": "pact-network-verifier/0.1",
        },
        signal,
      });

      if (res.status === 404) return null;
      if (res.status === 429) {
        throw Object.assign(new Error("rate-limited"), { code: "RATE_LIMITED" });
      }
      if (res.status >= 500) {
        throw Object.assign(new Error(`upstream ${res.status}`), {
          code: "UPSTREAM_ERROR",
        });
      }
      if (res.status >= 400) {
        throw Object.assign(new Error(`client ${res.status}`), {
          code: "CLIENT_ERROR",
        });
      }

      const body = (await res.json()) as {
        data?: {
          items?: Array<{
            tx_hash?: string;
            block_signed_at?: string;
            transfers?: Array<{
              from_address?: string;
              to_address?: string;
              delta?: string;
              contract_address?: string;
            }>;
          }>;
        };
      };

      const item = body.data?.items?.[0];
      if (!item) return null;

      return {
        signature: item.tx_hash ?? txSig,
        blockTime: item.block_signed_at ?? null,
        transfers: (item.transfers ?? []).map((t) => ({
          fromAddress: t.from_address ?? "",
          toAddress: t.to_address ?? "",
          amount: t.delta ?? "0",
          tokenAddress: t.contract_address,
        })),
      };
    },
  };
}

export interface VerifierConfig {
  client: GoldRushClient | null;
  timeoutMs?: number;
  maxAttempts?: number;
  recordMetric?: (detail: VerificationDetail) => void;
}

export class GoldRushVerifier {
  constructor(private readonly cfg: VerifierConfig) {}

  /**
   * Verify a claim against GoldRush. Always resolves — never throws.
   * Returns "skipped" when the input is unverifiable (no tx sig, no client).
   */
  async verify(input: VerificationInput): Promise<VerificationDetail> {
    const recordMetric = this.cfg.recordMetric ?? (() => {});

    if (!input.txSignature) {
      const detail: VerificationDetail = {
        result: "skipped",
        reason: "call record has no upstream tx signature",
        latencyMs: null,
        confidence: "none",
        cacheHit: false,
      };
      recordMetric(detail);
      return detail;
    }

    if (!this.cfg.client) {
      const detail: VerificationDetail = {
        result: "skipped",
        reason: "GoldRush client not configured (GOLDRUSH_API_KEY unset)",
        latencyMs: null,
        confidence: "none",
        cacheHit: false,
      };
      recordMetric(detail);
      return detail;
    }

    gc();
    const ck = dedupeKey(input);
    const cached = cache.get(ck);
    if (cached && cached.expiresAt > Date.now()) {
      const detail = { ...cached.detail, cacheHit: true };
      recordMetric(detail);
      return detail;
    }

    const timeoutMs = this.cfg.timeoutMs ?? TIMEOUT_MS;
    const maxAttempts = this.cfg.maxAttempts ?? MAX_ATTEMPTS;
    const started = Date.now();
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const tx = await this.cfg.client.fetchTransaction(
          input.txSignature,
          ac.signal,
        );
        clearTimeout(t);
        const latencyMs = Date.now() - started;
        if (!tx) {
          const detail: VerificationDetail = {
            result: "mismatch",
            reason: "GoldRush has no record of this signature",
            latencyMs,
            confidence: "medium",
            cacheHit: false,
          };
          cache.set(ck, { detail, expiresAt: Date.now() + CACHE_TTL_MS });
          recordMetric(detail);
          return detail;
        }
        const evaluated = evaluate(input, tx);
        const detail = { ...evaluated, latencyMs };
        cache.set(ck, { detail, expiresAt: Date.now() + CACHE_TTL_MS });
        recordMetric(detail);
        return detail;
      } catch (err) {
        clearTimeout(t);
        lastErr = err;
        if (attempt < maxAttempts) continue;
        break;
      }
    }

    const reason =
      lastErr instanceof Error
        ? `GoldRush call failed: ${lastErr.message}`
        : "GoldRush call failed";
    const detail: VerificationDetail = {
      result: "unavailable",
      reason,
      latencyMs: Date.now() - started,
      confidence: "none",
      cacheHit: false,
    };
    recordMetric(detail);
    return detail;
  }

  /** Test-only: clear the in-process cache. */
  static _clearCacheForTest(): void {
    cache.clear();
  }
}
