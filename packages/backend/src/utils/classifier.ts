/**
 * Authoritative response classifier (Commit 4 / PR #223 Section A).
 *
 * Pure port of the merchant SDK's `defaultClassify` at
 * `packages/sdk/src/merchant/classifier.ts` so the backend can recompute
 * the classification independently and ignore whatever the merchant claimed
 * in `body.classification`. The duplication is intentional — see
 * `packages/market-proxy/src/__tests__/classifier-parity.test.ts` which
 * locks the two surfaces together. Future work extracts both into
 * `@pact-network/core` once the cross-package version coupling is OK.
 *
 * Spec § Trust boundaries: "Pact's classifier is authoritative. The
 * merchant's classifyResponse is a hint; the backend re-runs the default
 * classifier on every observation and audits divergence."
 */

export type Classification =
  | "success"
  | "timeout"
  | "client_error"
  | "server_error"
  | "schema_mismatch";

export interface ClassifyInput {
  statusCode: number;
  latencyMs: number;
  /** Optional override; default 5000ms matches the SDK helper. */
  latencyThresholdMs?: number;
}

export const DEFAULT_LATENCY_THRESHOLD_MS = 5_000;

export function defaultClassify(input: ClassifyInput): Classification {
  const threshold = input.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS;
  if (input.latencyMs >= threshold) return "timeout";
  if (input.statusCode >= 500) return "server_error";
  if (input.statusCode >= 400) return "client_error";
  return "success";
}
