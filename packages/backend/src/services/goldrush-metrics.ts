/**
 * Prometheus metrics for the GoldRush verification gate.
 *
 * Kept in a separate module from the verifier so the verifier remains a pure
 * function of its config + inputs. The Fastify entrypoint wires
 * `recordGoldrushMetric` into the verifier and exposes `/metrics`.
 *
 * Naming follows the Step 5 brief verbatim:
 *   goldrush_verifications_total{result=match|mismatch|unavailable|stale|skipped}
 *   goldrush_verification_latency_seconds
 *
 * The prom-client default registry is shared with any future per-process
 * metrics (e.g. claim adjudication latency) so a single /metrics scrape
 * covers everything.
 */
import { Counter, Histogram, register } from "prom-client";
import type { VerificationDetail } from "./goldrush-verifier.js";

const verifications = new Counter({
  name: "goldrush_verifications_total",
  help: "Total claim verifications attempted against GoldRush, by result.",
  labelNames: ["result", "cache_hit"] as const,
  registers: [register],
});

const latency = new Histogram({
  name: "goldrush_verification_latency_seconds",
  help: "End-to-end latency of a GoldRush verification call (incl. retries).",
  // Buckets chosen for a 3s timeout: anything ≥3s is a timeout, the bulk
  // should be <250ms on a healthy upstream.
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
  registers: [register],
});

export function recordGoldrushMetric(detail: VerificationDetail): void {
  verifications.inc({
    result: detail.result,
    cache_hit: detail.cacheHit ? "true" : "false",
  });
  if (detail.latencyMs != null) {
    latency.observe(detail.latencyMs / 1000);
  }
}

export { register as goldrushRegistry };
