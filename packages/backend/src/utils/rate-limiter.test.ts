import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxPerWindow: 100, windowMs: 3600_000 });
  });

  it("allows requests under the limit", () => {
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 99);
  });

  it("tracks count across multiple calls", () => {
    for (let i = 0; i < 50; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 49);
  });

  it("rejects when limit is reached", () => {
    for (let i = 0; i < 100; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 100; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-2");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 99);
  });

  it("resets after window expires", () => {
    for (let i = 0; i < 100; i++) {
      limiter.check("agent-1");
    }
    limiter._expireKey("agent-1");
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 99);
  });

  it("reports warning threshold at 80%", () => {
    for (let i = 0; i < 80; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.warning, true);
  });

  it("does not report warning below 80%", () => {
    for (let i = 0; i < 78; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.warning, false);
  });

  it("increment adds count in bulk", () => {
    const result = limiter.increment("agent-1", 95);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 5);
    assert.equal(result.warning, true);
  });

  it("increment rejects if bulk exceeds limit", () => {
    const result = limiter.increment("agent-1", 101);
    assert.equal(result.allowed, false);
  });
});
