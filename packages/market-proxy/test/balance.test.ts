// Balance check tests — exercise the SPL Token approval allowance model
// via wrap's createDefaultBalanceCheck. We stub the JSON-RPC fetch so the
// tests don't hit any real network.

import { describe, test, expect, vi } from "vitest";
import { createBalanceCheck } from "../src/lib/balance.js";

function rpcFetchStub(opts: {
  ataBalance?: string | null;
  delegatedAmount?: string | null;
  notFound?: boolean;
}): typeof fetch {
  return vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body) as { method: string };
    if (body.method === "getTokenAccountBalance") {
      if (opts.notFound) {
        return new Response(
          JSON.stringify({ error: { code: -32602, message: "could not find account" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ result: { value: { amount: opts.ataBalance ?? "0" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (body.method === "getAccountInfo") {
      return new Response(
        JSON.stringify({
          result: {
            value: {
              data: {
                parsed: {
                  info: {
                    delegatedAmount: { amount: opts.delegatedAmount ?? "0" },
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as unknown as typeof fetch;
}

describe("createBalanceCheck (SPL Token approval model)", () => {
  test("eligible when ATA balance and allowance both >= required", async () => {
    const check = createBalanceCheck({
      rpcUrl: "http://localhost:8899",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      fetchImpl: rpcFetchStub({ ataBalance: "1000", delegatedAmount: "1000" }),
      resolveAta: () => "stubAta",
    });
    const r = await check.check("walletA", 500n);
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.ataBalance).toBe(1000n);
      expect(r.allowance).toBe(1000n);
    }
  });

  test("rejects with insufficient_balance when ATA balance < required", async () => {
    const check = createBalanceCheck({
      rpcUrl: "http://localhost:8899",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      fetchImpl: rpcFetchStub({ ataBalance: "100", delegatedAmount: "1000" }),
      resolveAta: () => "stubAta",
    });
    const r = await check.check("walletB", 500n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("insufficient_balance");
  });

  test("rejects with insufficient_allowance when allowance < required", async () => {
    const check = createBalanceCheck({
      rpcUrl: "http://localhost:8899",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      fetchImpl: rpcFetchStub({ ataBalance: "1000", delegatedAmount: "100" }),
      resolveAta: () => "stubAta",
    });
    const r = await check.check("walletC", 500n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("insufficient_allowance");
  });

  test("rejects with no_ata when the ATA does not exist", async () => {
    const check = createBalanceCheck({
      rpcUrl: "http://localhost:8899",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      fetchImpl: rpcFetchStub({ notFound: true }),
      resolveAta: () => "missingAta",
    });
    const r = await check.check("walletD", 500n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("no_ata");
  });

  test("caches results across calls within TTL", async () => {
    const fetchImpl = rpcFetchStub({ ataBalance: "1000", delegatedAmount: "1000" });
    const check = createBalanceCheck({
      rpcUrl: "http://localhost:8899",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      fetchImpl,
      resolveAta: () => "stubAta",
    });
    await check.check("walletE", 500n);
    await check.check("walletE", 500n);
    // first call: 2 RPC requests (balance + accountInfo); second: 0 (cached)
    expect((fetchImpl as any).mock.calls.length).toBe(2);
  });
});
