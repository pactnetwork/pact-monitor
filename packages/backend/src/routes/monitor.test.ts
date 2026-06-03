// Regression guard for the scorecard monitor classifier after it was re-pointed
// onto the shared rails core (@pact-network/classifier). This pins the exact
// behavior the route had as an inline copy-paste, so the de-dup provably did
// not drift. Behavior must match monitor's classify(threshold=5000, no schema).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./monitor.js";

describe("scorecard classify (re-pointed onto rails core)", () => {
  it("2xx within threshold -> success", () => {
    assert.equal(classify(200, 100, false), "success");
  });

  it("2xx over 5000ms threshold -> timeout", () => {
    assert.equal(classify(200, 6000, false), "timeout");
  });

  it("exactly at 5000ms threshold is NOT timeout (strict >)", () => {
    assert.equal(classify(200, 5000, false), "success");
  });

  it("5xx -> server_error", () => {
    assert.equal(classify(500, 100, false), "server_error");
    assert.equal(classify(503, 100, false), "server_error");
  });

  it("4xx -> client_error", () => {
    assert.equal(classify(400, 100, false), "client_error");
    assert.equal(classify(401, 100, false), "client_error");
    assert.equal(classify(403, 100, false), "client_error");
    assert.equal(classify(404, 100, false), "client_error");
    assert.equal(classify(429, 100, false), "client_error");
  });

  it("network error (statusCode 0 / flag) -> server_error", () => {
    assert.equal(classify(0, 0, true), "server_error");
    assert.equal(classify(0, 100, false), "server_error");
  });

  it("non-2xx-or-error codes (1xx, 3xx, >=600) -> server_error (conservative)", () => {
    assert.equal(classify(100, 100, false), "server_error");
    assert.equal(classify(301, 100, false), "server_error");
    assert.equal(classify(302, 100, false), "server_error");
    assert.equal(classify(600, 100, false), "server_error");
  });
});
