import { describe, test, expect } from "vitest";
import { verifyPayment } from "../src/lib/payment-verify.js";

// Minimal stub of @solana/web3.js Connection.getParsedTransaction.
function stubConnection(impl: (sig: string) => unknown) {
  return {
    getParsedTransaction: async (sig: string) => impl(sig),
  } as unknown as Parameters<typeof verifyPayment>[0]["connection"];
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYEE = "PayeePubkey1111111111111111111111111111111";
// The legitimate claiming agent — also the OWNER of the paying token account.
const AGENT = "AgentPubkey111111111111111111111111111111";
// An attacker claiming a stranger's payment under their own identity.
const ATTACKER = "AttackerPubkey11111111111111111111111111111";
const SIG = "5q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk";

describe("verifyPayment", () => {
  test("ok: payee received + agent-owned account decreased by >= amount", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          // Agent's paying account before: 5000.
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "5000" } },
          // Payee's receiving account before: 500.
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "500" } },
        ],
        postTokenBalances: [
          // Agent paid 1000: 5000 -> 4000.
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "4000" } },
          // Payee received 1000: 500 -> 1500.
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "1500" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: true, observedAmount: 1_000n });
  });

  test("ok: payee's token account did not exist before (absent from preBalances)", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 5, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "9000" } },
        ],
        postTokenBalances: [
          { accountIndex: 5, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "7000" } },
          { accountIndex: 7, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "2000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 2_000n,
    });
    expect(r).toEqual({ ok: true, observedAmount: 2_000n });
  });

  test("ok: agent's source account closed (in pre, absent in post → drained to 0)", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          // Agent's account held exactly 2000; the payment drains and closes it.
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "2000" } },
        ],
        postTokenBalances: [
          // Agent account absent (closed) → after = 0, decrease = 2000.
          { accountIndex: 4, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "2000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 2_000n,
    });
    expect(r).toEqual({ ok: true, observedAmount: 2_000n });
  });

  test("ok: agent moved MORE than the amount (decrease >= amount)", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "10000" } },
        ],
        postTokenBalances: [
          // Agent's account dropped by 6000 (e.g. paid merchant + a tip); the
          // premium-relevant amount is 1000, and 6000 >= 1000.
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "4000" } },
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "1000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: true, observedAmount: 1_000n });
  });

  // ---- agent-tasks#10: cross-agent replay (THE ATTACK) must be REJECTED ----
  test("rejected: payee received but claiming agent is NOT the source → agent_not_source", async () => {
    // The real payer (AGENT) funded the merchant. The ATTACKER reads the public
    // tx signature and re-registers it under their own identity. The payee
    // really got paid, but no ATTACKER-owned account decreased.
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "5000" } },
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "4000" } },
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "1000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: ATTACKER,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "agent_not_source" });
  });

  test("rejected: agent-owned account decreased by LESS than amount → agent_not_source", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          // Agent only spent 999 from their own account — short of the claim.
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "5000" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "4001" } },
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "1000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "agent_not_source" });
  });

  test("rejected: agent's source account is a DIFFERENT mint → agent_not_source", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 2, mint: "NotUSDC1111111111111111111111111111111111", owner: AGENT, uiTokenAmount: { amount: "5000" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: "NotUSDC1111111111111111111111111111111111", owner: AGENT, uiTokenAmount: { amount: "4000" } },
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "1000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "agent_not_source" });
  });

  test("rejected: amount too small (payee delta < amount) → no_matching_transfer", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "5000" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "4001" } },
          { accountIndex: 1, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "999" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  test("rejected: transfer to a different owner → no_matching_transfer", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "5000" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "4000" } },
          { accountIndex: 1, mint: USDC, owner: "SomeoneElse111111111111111111111111111111", uiTokenAmount: { amount: "5000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  test("rejected: wrong mint to payee → no_matching_transfer", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "5000" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: AGENT, uiTokenAmount: { amount: "4000" } },
          { accountIndex: 1, mint: "NotUSDC1111111111111111111111111111111111", owner: PAYEE, uiTokenAmount: { amount: "5000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  test("rejected: tx not found", async () => {
    const conn = stubConnection(() => null);
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "tx_not_found" });
  });

  test("rejected: tx errored on-chain", async () => {
    const conn = stubConnection(() => ({
      meta: { err: { InstructionError: [0, "Custom"] }, preTokenBalances: [], postTokenBalances: [] },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "tx_failed" });
  });

  test("rejected: RPC throws → rpc_error", async () => {
    const conn = stubConnection(() => {
      throw new Error("connection reset");
    });
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      agent: AGENT,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "rpc_error" });
  });
});
