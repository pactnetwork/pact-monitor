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
