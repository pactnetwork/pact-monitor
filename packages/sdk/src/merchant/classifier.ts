/**
 * Default response classifier — mirrors the backend's allowed values in
 * `packages/backend/src/routes/records.ts` so the merchant SDK never emits a
 * classification the backend would reject.
 *
 * The merchant-supplied `classifyResponse(req, res)` hint is composed AFTER
 * this default — if the hint returns a non-undefined value, it wins for the
 * outbound observation. The backend re-runs the default classifier as the
 * authoritative classification (spec §4 trust boundary).
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
  /** Optional cap from MerchantConfig / middleware options (ms). */
  latencyThresholdMs?: number;
}

const DEFAULT_LATENCY_THRESHOLD_MS = 5_000;

export function defaultClassify(input: ClassifyInput): Classification {
  const threshold = input.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS;
  if (input.latencyMs >= threshold) return "timeout";
  if (input.statusCode >= 500) return "server_error";
  if (input.statusCode >= 400) return "client_error";
  return "success";
}
