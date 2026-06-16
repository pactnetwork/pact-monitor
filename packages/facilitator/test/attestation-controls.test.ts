// Unit tests for the PURE client-attested abuse-control decision function
// (agent-tasks#10). No I/O — every input is injected.

import { describe, test, expect } from "vitest";
import {
  evaluateClientAttestation,
  isAttestationGateMode,
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

  test("clean agent with a normal refund is allowed", () => {
    // A "normal" refund must sit UNDER the per-agent window cap (tightened to
    // 1_000_000n by the harden PR); 900_000n is a clearly-normal single claim
    // for a clean agent. (Was 1_001_000n, stranded above the tightened cap.)
    const d = evaluateClientAttestation({ thisRefundLamports: 900_000n, stats: CLEAN });
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
    test("no pact_observed samples → rate rule is skipped even for an all-breach agent", () => {
      // 20/20 breaches would normally blow past the 0.5 floor and throttle, but
      // with zero trustworthy baseline samples there is nothing to judge against
      // → fail OPEN. Rule 1 + the on-chain hourly cap remain the bounds.
      const d = evaluateClientAttestation({
        thisRefundLamports: 1_000n,
        stats: {
          ...CLEAN,
          agentCoveredClaimsInWindow: 20,
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
