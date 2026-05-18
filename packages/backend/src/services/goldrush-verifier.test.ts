/**
 * Unit tests for the GoldRush verifier.
 *
 * The verifier is split into a pure evaluate() (no IO) and a verify() that
 * wraps it with HTTP + cache + timeout. We test both, plus the failure
 * modes the brief calls out:
 *   - GoldRush down  → "unavailable" (never throws)
 *   - GoldRush slow  → 3s timeout → "unavailable"
 *   - GoldRush 429   → "unavailable" after retry
 *   - GoldRush stale → "stale" with low confidence
 *   - GoldRush 404   → "mismatch" (no tx record)
 *   - GoldRush match → "match" with high confidence
 *   - Missing tx sig → "skipped" (call_records.tx_hash was null)
 *
 * If any of these test cases regress, the additive-not-blocking invariant
 * has been broken and Pact's claim adjudication risks getting wedged.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  GoldRushVerifier,
  evaluate,
  compareAmount,
  parseBlockTime,
  type GoldRushClient,
  type GoldRushTxResponse,
} from "./goldrush-verifier.js";

const AGENT = "AgentPubkeyTestAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RECIPIENT = "RecipientPubkeyTestBBBBBBBBBBBBBBBBBBBBBBBBBB";

function txWith(opts: Partial<GoldRushTxResponse> = {}): GoldRushTxResponse {
  return {
    signature: "sig123",
    blockTime: Math.floor(Date.now() / 1000),
    transfers: [
      {
        fromAddress: AGENT,
        toAddress: RECIPIENT,
        amount: 10000,
      },
    ],
    ...opts,
  };
}

describe("compareAmount", () => {
  it("matches exact", () => {
    assert.equal(compareAmount(10000, 10000), true);
  });
  it("matches within 1% tolerance (priority-fee skew)", () => {
    assert.equal(compareAmount(10050, 10000), true);
  });
  it("rejects beyond tolerance", () => {
    assert.equal(compareAmount(10200, 10000), false);
  });
  it("zero expected requires zero observed", () => {
    assert.equal(compareAmount(0, 0), true);
    assert.equal(compareAmount(1, 0), false);
  });
});

describe("parseBlockTime", () => {
  it("handles unix seconds", () => {
    const d = parseBlockTime(1715000000);
    assert.ok(d);
    assert.equal(d!.getUTCFullYear(), 2024);
  });
  it("handles ISO strings", () => {
    const d = parseBlockTime("2026-05-18T04:00:00Z");
    assert.ok(d);
    assert.equal(d!.getUTCMonth(), 4);
  });
  it("returns null on garbage", () => {
    assert.equal(parseBlockTime("not-a-date"), null);
    assert.equal(parseBlockTime(null), null);
  });
});

describe("evaluate", () => {
  const baseInput = {
    txSignature: "sig123",
    agentPubkey: AGENT,
    recipientAddress: RECIPIENT,
    expectedAmount: 10000,
    callTimestamp: new Date(),
  };

  it("returns match when sender/recipient/amount all align", () => {
    const d = evaluate(baseInput, txWith());
    assert.equal(d.result, "match");
    assert.equal(d.confidence, "high");
  });

  it("returns mismatch when no transfer is from the agent", () => {
    const d = evaluate(
      baseInput,
      txWith({
        transfers: [{ fromAddress: "SomeoneElse", toAddress: RECIPIENT, amount: 10000 }],
      }),
    );
    assert.equal(d.result, "mismatch");
    assert.match(d.reason, /no transfer from agent/);
  });

  it("returns mismatch when recipient differs", () => {
    const d = evaluate(
      baseInput,
      txWith({
        transfers: [{ fromAddress: AGENT, toAddress: "WrongRecipient", amount: 10000 }],
      }),
    );
    assert.equal(d.result, "mismatch");
  });

  it("returns mismatch when amount differs > 1%", () => {
    const d = evaluate(
      baseInput,
      txWith({
        transfers: [{ fromAddress: AGENT, toAddress: RECIPIENT, amount: 20000 }],
      }),
    );
    assert.equal(d.result, "mismatch");
  });

  it("returns stale when blockTime is far from callTimestamp", () => {
    const oldTime = Math.floor((Date.now() - 10 * 60_000) / 1000);
    const d = evaluate(baseInput, txWith({ blockTime: oldTime }));
    assert.equal(d.result, "stale");
    assert.equal(d.confidence, "low");
  });

  it("downgrades confidence when only sender is checkable", () => {
    const d = evaluate(
      { ...baseInput, recipientAddress: null, expectedAmount: null },
      txWith(),
    );
    assert.equal(d.result, "match");
    assert.equal(d.confidence, "medium");
  });
});

describe("GoldRushVerifier.verify", () => {
  beforeEach(() => {
    GoldRushVerifier._clearCacheForTest();
  });

  function client(impl: GoldRushClient["fetchTransaction"]): GoldRushClient {
    return { fetchTransaction: impl };
  }

  it("returns skipped when no client is configured", async () => {
    const v = new GoldRushVerifier({ client: null });
    const d = await v.verify({
      txSignature: "anything",
      agentPubkey: AGENT,
      recipientAddress: RECIPIENT,
      expectedAmount: 100,
      callTimestamp: new Date(),
    });
    assert.equal(d.result, "skipped");
  });

  it("returns skipped when txSignature is null (Pact didn't record it)", async () => {
    const v = new GoldRushVerifier({
      client: client(async () => txWith()),
    });
    const d = await v.verify({
      txSignature: null,
      agentPubkey: AGENT,
      recipientAddress: RECIPIENT,
      expectedAmount: 100,
      callTimestamp: new Date(),
    });
    assert.equal(d.result, "skipped");
    assert.match(d.reason, /no upstream tx signature/);
  });

  it("returns mismatch when GoldRush returns null (404, no record)", async () => {
    const v = new GoldRushVerifier({
      client: client(async () => null),
    });
    const d = await v.verify({
      txSignature: "sig123",
      agentPubkey: AGENT,
      recipientAddress: RECIPIENT,
      expectedAmount: 10000,
      callTimestamp: new Date(),
    });
    assert.equal(d.result, "mismatch");
    assert.match(d.reason, /no record/);
  });

  it("retries once on transient error then returns unavailable", async () => {
    let calls = 0;
    const v = new GoldRushVerifier({
      client: client(async () => {
        calls++;
        throw new Error("boom");
      }),
      maxAttempts: 2,
    });
    const d = await v.verify({
      txSignature: "sig123",
      agentPubkey: AGENT,
      recipientAddress: RECIPIENT,
      expectedAmount: 10000,
      callTimestamp: new Date(),
    });
    assert.equal(calls, 2);
    assert.equal(d.result, "unavailable");
    assert.equal(d.confidence, "none");
  });

  it("respects the 3s timeout", async () => {
    const v = new GoldRushVerifier({
      client: client((_sig, signal) =>
        new Promise<GoldRushTxResponse | null>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ),
      timeoutMs: 50,
      maxAttempts: 1,
    });
    const started = Date.now();
    const d = await v.verify({
      txSignature: "sig123",
      agentPubkey: AGENT,
      recipientAddress: RECIPIENT,
      expectedAmount: 10000,
      callTimestamp: new Date(),
    });
    const elapsed = Date.now() - started;
    assert.equal(d.result, "unavailable");
    assert.ok(elapsed < 500, `expected fast bail, took ${elapsed}ms`);
  });

  it("caches a positive result for 5 minutes (same input tuple)", async () => {
    let calls = 0;
    const v = new GoldRushVerifier({
      client: client(async () => {
        calls++;
        return txWith();
      }),
    });
    const input = {
      txSignature: "sig123",
      agentPubkey: AGENT,
      recipientAddress: RECIPIENT,
      expectedAmount: 10000,
      callTimestamp: new Date(),
    };
    const d1 = await v.verify(input);
    const d2 = await v.verify(input);
    assert.equal(d1.result, "match");
    assert.equal(d2.result, "match");
    assert.equal(d2.cacheHit, true);
    assert.equal(calls, 1);
  });

  it("never throws on bad client (additive-not-blocking invariant)", async () => {
    const v = new GoldRushVerifier({
      client: client(async () => {
        throw new TypeError("totally broken");
      }),
      maxAttempts: 1,
    });
    const d = await v.verify({
      txSignature: "sig123",
      agentPubkey: AGENT,
      recipientAddress: RECIPIENT,
      expectedAmount: 10000,
      callTimestamp: new Date(),
    });
    assert.equal(d.result, "unavailable");
  });
});
