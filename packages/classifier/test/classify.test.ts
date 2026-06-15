import { describe, test, expect } from "vitest";
import { classifyHttpOutcome, type CoreCategory } from "../src/index";

// Unit tests for the neutral status -> category decision tree. These pin the
// core's own behavior independent of any consumer vocabulary. The cross-package
// parity contract (wrap Outcome + monitor Classification deriving from these
// same inputs) lives in parity.test.ts.

const T = 5000; // latency threshold

function core(
  statusCode: number | null,
  latencyMs: number,
  networkError = false,
): CoreCategory {
  return classifyHttpOutcome({ statusCode, latencyMs, latencyThresholdMs: T, networkError });
}

describe("classifyHttpOutcome", () => {
  test("null response -> network_error", () => {
    expect(core(null, 100)).toBe("network_error");
  });

  test("networkError flag -> network_error (even with a status)", () => {
    expect(core(0, 0, true)).toBe("network_error");
    expect(core(200, 100, true)).toBe("network_error");
  });

  test("statusCode 0 -> network_error", () => {
    expect(core(0, 100)).toBe("network_error");
  });

  test("5xx -> server_error (500 and 599 bounds)", () => {
    expect(core(500, 100)).toBe("server_error");
    expect(core(503, 100)).toBe("server_error");
    expect(core(599, 100)).toBe("server_error");
  });

  test("4xx -> client_error (400, 429, 499 bounds)", () => {
    expect(core(400, 100)).toBe("client_error");
    expect(core(401, 100)).toBe("client_error");
    expect(core(403, 100)).toBe("client_error");
    expect(core(404, 100)).toBe("client_error");
    expect(core(429, 100)).toBe("client_error");
    expect(core(499, 100)).toBe("client_error");
  });

  test("2xx within threshold -> success", () => {
    expect(core(200, 100)).toBe("success");
    expect(core(204, 4999)).toBe("success");
  });

  test("2xx over threshold -> slow", () => {
    expect(core(200, 6000)).toBe("slow");
    expect(core(201, 5001)).toBe("slow");
  });

  test("latency exactly at threshold is NOT slow (strict >)", () => {
    expect(core(200, T)).toBe("success");
  });

  test("3xx -> other (neither clean success nor a recognized error)", () => {
    expect(core(301, 100)).toBe("other");
    expect(core(302, 100)).toBe("other");
  });

  test("1xx and >=600 -> other", () => {
    expect(core(100, 100)).toBe("other");
    expect(core(199, 100)).toBe("other");
    expect(core(600, 100)).toBe("other");
  });
});
