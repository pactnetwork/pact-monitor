// Unit tests for the PURE client-attested abuse-control decision function
// (agent-tasks#10). No I/O — every input is injected.

import { describe, test, expect } from "vitest";
import {
  evaluateClientAttestation,
  isAttestationGateMode,
  perAgentRefundCapFor,
  DEFAULT_THRESHOLDS,
  type AttestationStats,
  type AttestationThresholds,
} from "../src/lib/attestation-controls.js";

const CLEAN: AttestationStats = {
  agentRefundLamportsInWindow: 0n,
  agentCoveredClaimsInWindow: 0,
  agentTotalCallsInWindow: 0,
  networkBreachClaimRate: 0.05,
  // Non-empty trustworthy baseline so the rate rule is active by default; the
  // empty-baseline fail-open path is exercised explicitly below.
  networkBaselineSamples: 100,
};

describe("isAttestationGateMode", () => {
  test("accepts the three modes, rejects others", () => {
    expect(isAttestationGateMode("off")).toBe(true);
    expect(isAttestationGateMode("log_only")).toBe(true);
    expect(isAttestationGateMode("enforce")).toBe(true);
    expect(isAttestationGateMode("ENFORCE")).toBe(false);
    expect(isAttestationGateMode("")).toBe(false);
  });
});

describe("evaluateClientAttestation", () => {
  test("zero/negative refund is always allowed (nothing to gate)", () => {
    expect(
      evaluateClientAttestation({ thisRefundLamports: 0n, stats: CLEAN }).decision,
    ).toBe("allow");
    expect(
      evaluateClientAttestation({ thisRefundLamports: -5n, stats: CLEAN }).decision,
    ).toBe("allow");
  });

  test("clean agent with a FULL single refund is allowed (pool-relative cap)", () => {
    // The whole point of the pool-relative cap (agent-tasks#10): an honest
    // agent's first full-size breach refund (imputedCost 1_000_000 + premium
    // 1_000 = 1_001_000) must NOT be throttled. The default cap is 3 full
    // refunds (3_003_000n), so a single 1_001_000 claim sits well under it.
    // (A flat 1_000_000n cap throttled exactly this — the bug this fixes.)
    const d = evaluateClientAttestation({ thisRefundLamports: 1_001_000n, stats: CLEAN });
    expect(d.decision).toBe("allow");
  });

  describe("rule 1 — per-agent refund cap", () => {
    test("at-cap with a positive claim trips the cap (projected > cap)", () => {
      const d = evaluateClientAttestation({
        thisRefundLamports: 1n,
        stats: { ...CLEAN, agentRefundLamportsInWindow: DEFAULT_THRESHOLDS.perAgentRefundCapLamportsPerWindow },
      });
      expect(d).toEqual({ decision: "throttle", reason: "per_agent_refund_cap" });
    });

    test("exactly at cap (projected == cap) is allowed — boundary is inclusive", () => {
      const cap = DEFAULT_THRESHOLDS.perAgentRefundCapLamportsPerWindow;
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: { ...CLEAN, agentRefundLamportsInWindow: cap - 1_000n },
      });
      expect(d.decision).toBe("allow");
    });

    test("cap rule fires before the rate rule (refund cap takes precedence)", () => {
      const d = evaluateClientAttestation({
        thisRefundLamports: 10_000_000n,
        stats: { ...CLEAN, agentCoveredClaimsInWindow: 100, agentTotalCallsInWindow: 100 },
      });
      expect(d).toEqual({ decision: "throttle", reason: "per_agent_refund_cap" });
    });
  });

  describe("rule 2 — breach-claim-rate anomaly", () => {
    test("high breach rate well above baseline → throttle", () => {
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: { ...CLEAN, agentCoveredClaimsInWindow: 18, agentTotalCallsInWindow: 20, networkBreachClaimRate: 0.05 },
      });
      expect(d).toEqual({ decision: "throttle", reason: "breach_claim_rate_anomaly" });
    });

    test("small sample (< minCallsForRateRule) is NEVER rate-throttled", () => {
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        // 9 calls, all breaches — but below the 10-call small-sample guard.
        stats: { ...CLEAN, agentCoveredClaimsInWindow: 9, agentTotalCallsInWindow: 9, networkBreachClaimRate: 0.01 },
      });
      expect(d.decision).toBe("allow");
    });

    test("absolute floor protects: rate above baseline*mult but below minBreachRateToFlag is allowed", () => {
      // baseline 0.01 * 3 = 0.03 ceiling-from-baseline; floor 0.5 wins → 0.5.
      // agent rate 0.2 > 0.03 but < 0.5 → NOT flagged.
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: { ...CLEAN, agentCoveredClaimsInWindow: 4, agentTotalCallsInWindow: 20, networkBreachClaimRate: 0.01 },
      });
      expect(d.decision).toBe("allow");
    });

    test("high network baseline raises the ceiling — a high-but-typical agent is allowed", () => {
      // baseline 0.4 * 3 = 1.2 ceiling; agent 0.6 < 1.2 → allowed even though > floor.
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: { ...CLEAN, agentCoveredClaimsInWindow: 12, agentTotalCallsInWindow: 20, networkBreachClaimRate: 0.4 },
      });
      expect(d.decision).toBe("allow");
    });
  });

  describe("rule 2 — empty-baseline fail-open (agent-tasks#10 NIT #3)", () => {
    test("empty baseline + >50% breach over enough calls → the ABSOLUTE FLOOR still throttles", () => {
      // Option B: the floor (0.5) is baseline-INDEPENDENT, so blatant abuse is
      // caught even during the bootstrap window with no pact_observed samples.
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: {
          ...CLEAN,
          agentCoveredClaimsInWindow: 18, // 0.9 > 0.5 floor
          agentTotalCallsInWindow: 20,
          networkBreachClaimRate: 0,
          networkBaselineSamples: 0,
        },
      });
      expect(d).toEqual({ decision: "throttle", reason: "breach_claim_rate_anomaly" });
    });

    test("empty baseline + <50% breach over enough calls → allowed (multiple fails open, floor not exceeded)", () => {
      // The baseline-relative term (rate*3) is dropped on an empty baseline, so a
      // sub-floor agent that the multiple MIGHT otherwise have flagged is allowed.
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: {
          ...CLEAN,
          agentCoveredClaimsInWindow: 8, // 0.4 < 0.5 floor
          agentTotalCallsInWindow: 20,
          networkBreachClaimRate: 0,
          networkBaselineSamples: 0,
        },
      });
      expect(d.decision).toBe("allow");
    });

    test("empty baseline does NOT disable rule 1 — the per-agent refund cap still fires", () => {
      const d = evaluateClientAttestation({
        thisRefundLamports: 1n,
        stats: {
          ...CLEAN,
          agentRefundLamportsInWindow: DEFAULT_THRESHOLDS.perAgentRefundCapLamportsPerWindow,
          networkBaselineSamples: 0,
        },
      });
      expect(d).toEqual({ decision: "throttle", reason: "per_agent_refund_cap" });
    });

    test("a genuine 0% breach rate over a NON-empty sample keeps the floor active", () => {
      // Distinct from "no samples": 500 trustworthy calls, 0 breaches → baseline
      // 0, ceiling floored at 0.5. An agent claiming 18/20 breaches is the
      // clearest anomaly → throttle.
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: {
          ...CLEAN,
          agentCoveredClaimsInWindow: 18,
          agentTotalCallsInWindow: 20,
          networkBreachClaimRate: 0,
          networkBaselineSamples: 500,
        },
      });
      expect(d).toEqual({ decision: "throttle", reason: "breach_claim_rate_anomaly" });
    });
  });

  test("custom thresholds are honoured", () => {
    const tight: AttestationThresholds = {
      perAgentRefundCapLamportsPerWindow: 500n,
      anomalyMultiple: 2,
      minBreachRateToFlag: 0.1,
      minCallsForRateRule: 1,
    };
    const d = evaluateClientAttestation({
      thisRefundLamports: 1_000n,
      stats: CLEAN,
      thresholds: tight,
    });
    expect(d).toEqual({ decision: "throttle", reason: "per_agent_refund_cap" });
  });
});

describe("perAgentRefundCapFor — pool-relative per-agent cap (agent-tasks#10)", () => {
  const POOL = { imputedCostLamports: 1_000_000n, flatPremiumLamports: 1_000n };

  test("default cap = 3 × (imputedCost + premium), matches DEFAULT_THRESHOLDS", () => {
    expect(perAgentRefundCapFor(POOL)).toBe(3_003_000n);
    expect(perAgentRefundCapFor(POOL)).toBe(
      DEFAULT_THRESHOLDS.perAgentRefundCapLamportsPerWindow,
    );
  });

  test("scales with the pool's per-call ceiling", () => {
    expect(
      perAgentRefundCapFor({ imputedCostLamports: 50_000n, flatPremiumLamports: 2_500n }),
    ).toBe(157_500n);
  });

  test("custom claim multiple", () => {
    expect(perAgentRefundCapFor(POOL, 1n)).toBe(1_001_000n);
  });

  test("a single FULL refund is under the pool-relative cap; the 4th trips it", () => {
    const cap = perAgentRefundCapFor(POOL); // 3_003_000n
    const single = POOL.imputedCostLamports + POOL.flatPremiumLamports; // 1_001_000n
    const thresholds: AttestationThresholds = {
      ...DEFAULT_THRESHOLDS,
      perAgentRefundCapLamportsPerWindow: cap,
    };
    // 1st full claim: projected 1_001_000 < cap → allow.
    expect(
      evaluateClientAttestation({
        thisRefundLamports: single,
        stats: { ...CLEAN, agentRefundLamportsInWindow: 0n },
        thresholds,
      }).decision,
    ).toBe("allow");
    // 4th full claim: 3 already in window (= cap) + another → over cap → throttle.
    expect(
      evaluateClientAttestation({
        thisRefundLamports: single,
        stats: { ...CLEAN, agentRefundLamportsInWindow: 3n * single },
        thresholds,
      }),
    ).toEqual({ decision: "throttle", reason: "per_agent_refund_cap" });
  });
});
