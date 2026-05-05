import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classifier.js";

describe("classify", () => {
  it("returns success for 200 status, low latency, no schema issues", () => {
    const result = classify(200, 100, 5000, { data: "ok" });
    assert.equal(result, "success");
  });

  it("returns server_error for 500 status (provider's fault — claimable)", () => {
    const result = classify(500, 100, 5000, null);
    assert.equal(result, "server_error");
  });

  it("returns server_error for 503 status", () => {
    const result = classify(503, 100, 5000, null);
    assert.equal(result, "server_error");
  });

  it("returns server_error for network error (statusCode=0, networkError=true)", () => {
    const result = classify(0, 0, 5000, null, undefined, true);
    assert.equal(result, "server_error");
  });

  it("returns client_error for 404 (agent's fault — NOT claimable)", () => {
    const result = classify(404, 100, 5000, null);
    assert.equal(result, "client_error");
  });

  it("returns client_error for 400 bad request", () => {
    const result = classify(400, 100, 5000, null);
    assert.equal(result, "client_error");
  });

  it("returns client_error for 401 unauthorized", () => {
    const result = classify(401, 100, 5000, null);
    assert.equal(result, "client_error");
  });

  it("returns client_error for 403 forbidden", () => {
    const result = classify(403, 100, 5000, null);
    assert.equal(result, "client_error");
  });

  it("returns client_error for 429 rate limited (agent should manage own rate-limiting)", () => {
    const result = classify(429, 100, 5000, null);
    assert.equal(result, "client_error");
  });

  it("returns timeout for 200 status but latency exceeding threshold", () => {
    const result = classify(200, 6000, 5000, { data: "ok" });
    assert.equal(result, "timeout");
  });

  it("returns schema_mismatch for 200 status but body missing required fields", () => {
    const result = classify(200, 100, 5000, { name: "test" }, {
      type: "object",
      required: ["id", "name"],
    });
    assert.equal(result, "schema_mismatch");
  });

  it("returns success for 200 with valid schema match", () => {
    const result = classify(200, 100, 5000, { id: 1, name: "test" }, {
      type: "object",
      required: ["id", "name"],
    });
    assert.equal(result, "success");
  });

  it("exactly at latency threshold should NOT be timeout", () => {
    const result = classify(200, 5000, 5000, { data: "ok" });
    assert.equal(result, "success");
  });

  it("301 redirect status falls through to server_error (conservative)", () => {
    const result = classify(301, 100, 5000, null);
    assert.equal(result, "server_error");
  });
});
