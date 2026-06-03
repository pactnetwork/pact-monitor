import { describe, test, expect } from "vitest";
import { classifyHttpOutcome, type CoreCategory } from "../src/index";

// Cross-package parity guardrail.
//
// This is the test that did not exist before the extraction: it pins ONE shared
// fixture set and asserts that the neutral core, wrap's Outcome, and monitor's
// Classification all derive consistently from it. If anyone's status->category
// logic drifts, this fails.
//
// It imports the REAL consumer sources by relative path (not as package deps)
// on purpose: declaring @pact-network/wrap / @q3labs/pact-monitor as deps of
// this package would create a classifier <-> wrap dependency cycle and break
// `turbo build`. The vitest alias in vitest.config.ts lets those sources
// resolve "@pact-network/classifier" back to this package's source.
import { defaultClassifier } from "../../wrap/src/classifier";
import type { Outcome } from "../../wrap/src/types";
import { classify as monitorClassify } from "../../monitor/src/classifier";
import type { Classification } from "../../monitor/src/types";

const FLAT = 500n;
const IMPUTED = 50_000n;
const T = 5000; // shared latency threshold

interface Fixture {
  name: string;
  statusCode: number | null;
  latencyMs: number;
  networkError?: boolean;
  /** monitor-only inputs (the core and wrap ignore the body/schema). */
  body?: unknown;
  schema?: { type: string; required?: string[] };
  // Expected outputs across the three vocabularies:
  core: CoreCategory;
  /** Expected wrap Outcome, or undefined when the status is not representable
   *  via a real Response (1xx / >=600 / pure network-flag fixtures). */
  wrap?: Outcome;
  wrapPremium?: bigint;
  wrapRefund?: bigint;
  monitor: Classification;
}

// The behavior matrix. wrap and monitor AGREE on network / 5xx / 4xx / 2xx and
// DIVERGE only on the `other` bucket (1xx, 3xx, >=600): wrap -> ok, monitor ->
// server_error. Both are preserved with zero drift via the `other` category.
const FIXTURES: Fixture[] = [
  // --- 2xx success / latency ---
  {
    name: "200 within threshold",
    statusCode: 200, latencyMs: 100, body: { data: "ok" },
    core: "success", wrap: "ok", wrapPremium: FLAT, wrapRefund: 0n, monitor: "success",
  },
  {
    name: "200 over threshold",
    statusCode: 200, latencyMs: 6000, body: { data: "ok" },
    core: "slow", wrap: "latency_breach", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "timeout",
  },
  {
    name: "200 exactly at threshold (strict >, not a breach)",
    statusCode: 200, latencyMs: T, body: { data: "ok" },
    core: "success", wrap: "ok", wrapPremium: FLAT, wrapRefund: 0n, monitor: "success",
  },
  {
    name: "201 (non-200 2xx) over threshold",
    statusCode: 201, latencyMs: 6000,
    core: "slow", wrap: "latency_breach", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "timeout",
  },
  {
    name: "204 (no body) over threshold",
    statusCode: 204, latencyMs: 6000,
    core: "slow", wrap: "latency_breach", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "timeout",
  },

  // --- 5xx server fault (covered) ---
  {
    name: "500",
    statusCode: 500, latencyMs: 100,
    core: "server_error", wrap: "server_error", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "server_error",
  },
  {
    name: "503",
    statusCode: 503, latencyMs: 100,
    core: "server_error", wrap: "server_error", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "server_error",
  },
  {
    name: "599 (5xx upper bound)",
    statusCode: 599, latencyMs: 100,
    core: "server_error", wrap: "server_error", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "server_error",
  },

  // --- 4xx caller fault (NOT covered) ---
  {
    name: "400",
    statusCode: 400, latencyMs: 100,
    core: "client_error", wrap: "client_error", wrapPremium: 0n, wrapRefund: 0n, monitor: "client_error",
  },
  {
    name: "401",
    statusCode: 401, latencyMs: 100,
    core: "client_error", wrap: "client_error", wrapPremium: 0n, wrapRefund: 0n, monitor: "client_error",
  },
  {
    name: "403",
    statusCode: 403, latencyMs: 100,
    core: "client_error", wrap: "client_error", wrapPremium: 0n, wrapRefund: 0n, monitor: "client_error",
  },
  {
    name: "404",
    statusCode: 404, latencyMs: 100,
    core: "client_error", wrap: "client_error", wrapPremium: 0n, wrapRefund: 0n, monitor: "client_error",
  },
  {
    name: "429 rate limited (caller manages its own rate)",
    statusCode: 429, latencyMs: 50,
    core: "client_error", wrap: "client_error", wrapPremium: 0n, wrapRefund: 0n, monitor: "client_error",
  },
  {
    name: "499 (4xx upper bound)",
    statusCode: 499, latencyMs: 100,
    core: "client_error", wrap: "client_error", wrapPremium: 0n, wrapRefund: 0n, monitor: "client_error",
  },

  // --- no response ---
  {
    name: "network error (no response)",
    statusCode: null, latencyMs: 100, networkError: true,
    core: "network_error", wrap: "network_error", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "server_error",
  },
  {
    name: "statusCode 0 + networkError (monitor-shaped)",
    statusCode: 0, latencyMs: 0, networkError: true,
    // wrap models no-response as a null Response (covered above), so no wrap col.
    core: "network_error", monitor: "server_error",
  },

  // --- the `other` bucket: THE wrap-vs-monitor divergence, both preserved ---
  {
    name: "301 redirect (wrap: ok / monitor: server_error)",
    statusCode: 301, latencyMs: 100,
    core: "other", wrap: "ok", wrapPremium: FLAT, wrapRefund: 0n, monitor: "server_error",
  },
  {
    name: "302 redirect (wrap: ok / monitor: server_error)",
    statusCode: 302, latencyMs: 100,
    core: "other", wrap: "ok", wrapPremium: FLAT, wrapRefund: 0n, monitor: "server_error",
  },
  {
    name: "100 (1xx) — not representable via Response; monitor server_error",
    statusCode: 100, latencyMs: 100,
    core: "other", monitor: "server_error",
  },
  {
    name: "600 (>=600) — not representable via Response; monitor server_error",
    statusCode: 600, latencyMs: 100,
    core: "other", monitor: "server_error",
  },

  // --- monitor-only schema branch (computed AROUND core success) ---
  {
    name: "200 within threshold, schema mismatch -> monitor schema_mismatch (wrap still ok)",
    statusCode: 200, latencyMs: 100,
    body: { name: "test" }, schema: { type: "object", required: ["id", "name"] },
    core: "success", wrap: "ok", wrapPremium: FLAT, wrapRefund: 0n, monitor: "schema_mismatch",
  },
  {
    name: "200 within threshold, schema match -> monitor success",
    statusCode: 200, latencyMs: 100,
    body: { id: 1, name: "test" }, schema: { type: "object", required: ["id", "name"] },
    core: "success", wrap: "ok", wrapPremium: FLAT, wrapRefund: 0n, monitor: "success",
  },
  {
    name: "200 OVER threshold + schema -> latency wins (monitor timeout, not schema_mismatch)",
    statusCode: 200, latencyMs: 6000,
    body: { name: "test" }, schema: { type: "object", required: ["id", "name"] },
    core: "slow", wrap: "latency_breach", wrapPremium: FLAT, wrapRefund: IMPUTED, monitor: "timeout",
  },
];

function buildResponse(f: Fixture): Response | null {
  if (f.networkError || f.statusCode === null || f.statusCode === 0) return null;
  // Response constructor only permits 200-599; 1xx/>=600 fixtures set wrap=undefined.
  const hasBody = f.statusCode !== 204 && f.statusCode >= 200;
  return new Response(hasBody ? "{}" : null, { status: f.statusCode });
}

describe("classifier parity: core <-> wrap <-> monitor", () => {
  for (const f of FIXTURES) {
    describe(f.name, () => {
      test("core category", () => {
        expect(
          classifyHttpOutcome({
            statusCode: f.statusCode,
            latencyMs: f.latencyMs,
            latencyThresholdMs: T,
            networkError: f.networkError,
          }),
        ).toBe(f.core);
      });

      test("monitor Classification derives from the same inputs", () => {
        const result = monitorClassify(
          f.statusCode ?? 0,
          f.latencyMs,
          T,
          f.body,
          f.schema,
          f.networkError,
        );
        expect(result).toBe(f.monitor);
      });

      if (f.wrap !== undefined) {
        test("wrap Outcome + economics derive from the same inputs", () => {
          const result = defaultClassifier.classify({
            response: buildResponse(f),
            latencyMs: f.latencyMs,
            endpointConfig: {
              sla_latency_ms: T,
              flat_premium_lamports: FLAT,
              imputed_cost_lamports: IMPUTED,
            },
          });
          expect(result.outcome).toBe(f.wrap);
          if (f.wrapPremium !== undefined) expect(result.premium).toBe(f.wrapPremium);
          if (f.wrapRefund !== undefined) expect(result.refund).toBe(f.wrapRefund);
        });
      }
    });
  }
});

// A guard on the divergence itself: for the `other` bucket the two vocabularies
// MUST disagree (wrap ok, monitor server_error). If a future change accidentally
// collapses them onto one answer, this documents that it was deliberate.
describe("the `other` divergence is intentional", () => {
  test("3xx: wrap says ok, monitor says server_error", () => {
    const wrapOut = defaultClassifier.classify({
      response: new Response(null, { status: 301 }),
      latencyMs: 100,
      endpointConfig: { sla_latency_ms: T, flat_premium_lamports: FLAT, imputed_cost_lamports: IMPUTED },
    });
    const monitorOut = monitorClassify(301, 100, T, null);
    expect(wrapOut.outcome).toBe("ok");
    expect(monitorOut).toBe("server_error");
    // ...but both come from the same neutral core category:
    expect(classifyHttpOutcome({ statusCode: 301, latencyMs: 100, latencyThresholdMs: T })).toBe("other");
  });
});
