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
const SIG = "5q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk";

describe("verifyPayment", () => {
  test("ok: payee's USDC token account delta >= amount", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "500" } },
        ],
        postTokenBalances: [
          { accountIndex: 3, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "1500" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: true, observedAmount: 1_000n });
  });

  test("ok: payee's token account did not exist before (absent from preBalances)", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [
          { accountIndex: 7, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "2000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      asset: USDC,
      amountBaseUnits: 2_000n,
    });
    expect(r).toEqual({ ok: true, observedAmount: 2_000n });
  });

  test("rejected: amount too small", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [
          { accountIndex: 1, mint: USDC, owner: PAYEE, uiTokenAmount: { amount: "999" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  test("rejected: transfer to a different owner", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [
          { accountIndex: 1, mint: USDC, owner: "SomeoneElse111111111111111111111111111111", uiTokenAmount: { amount: "5000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "no_matching_transfer" });
  });

  test("rejected: wrong mint", async () => {
    const conn = stubConnection(() => ({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [
          { accountIndex: 1, mint: "NotUSDC1111111111111111111111111111111111", owner: PAYEE, uiTokenAmount: { amount: "5000" } },
        ],
      },
    }));
    const r = await verifyPayment({
      connection: conn,
      paymentSignature: SIG,
      payee: PAYEE,
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
      asset: USDC,
      amountBaseUnits: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: "rpc_error" });
  });
});
