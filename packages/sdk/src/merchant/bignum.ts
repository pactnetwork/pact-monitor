/**
 * Tolerant bigint coercion shared across merchant SDK surfaces.
 *
 * The backend returns micro-USDC sums as decimal strings because the JSON
 * number type can't carry values past 2^53. Consumers want native bigint.
 * This helper accepts whatever the wire actually delivered (string, number,
 * bigint) and returns 0n on malformed input rather than throwing — the
 * merchant SDK's golden rule mirrors the agent SDK's: backend hiccups
 * surface in the shape (zero) rather than in exceptions.
 */
export function bigOrZero(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return 0n;
}
